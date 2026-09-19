import type { AppUpdater, ProgressInfo } from "electron-updater";
import type { InstallKind, UpdateProgress, UpdateStatus } from "../shared/types";

// Desktop updates against the GitHub Releases feed (electron-builder.yml
// publish block). Only AppImage and NSIS builds can swap themselves out;
// every other install channel owns its files (pacman, flatpak, the Mac
// bundle), so the app only tells the player where the new version lives.
//
// electron-updater answers null instead of checking whenever it does not
// recognise the install (on Linux that is anything but an AppImage), which
// used to read as "up to date" on a tar.gz or rpm install. So the installs
// that cannot self-update ask GitHub for the latest release directly, and
// the self-updating ones fall back to that same question when the feed
// declines to answer.
//
// electron-updater drags in electron at require time, so it loads lazily
// inside the class: this module must stay importable under plain node for
// the unit tests.

// The background check runs as soon as the window can hear the answer: a
// player on an old build should know before they have joined a table, since a
// mismatched app and host is its own source of trouble.
const STARTUP_CHECK_DELAY_MS = 1_200;

const REPO = "Lebbitheplow/open-dungeon-master-client";
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

const SELF_UPDATE_KINDS: ReadonlySet<InstallKind> = new Set(["appimage", "nsis"]);

// Installs that cannot swap themselves out but whose new build is one file on
// the release: the app fetches that file and hands it to the system (the
// package installer for an rpm or deb, the disk image for a Mac, the folder
// for a tar.gz), instead of sending the player to a web page to work out
// which of twenty assets is theirs.
export type PackageFormat = "rpm" | "deb" | "";

export function packageAssetName(
  version: string,
  kind: InstallKind,
  platform: NodeJS.Platform,
  arch: string,
  format: PackageFormat,
): string {
  const base = `open-dungeon-master-client-${version}`;
  if (platform === "darwin" && kind === "mac") return `${base}-${arch === "arm64" ? "arm64" : "x64"}-mac.dmg`;
  if (platform !== "linux" || arch !== "x64") return "";
  if (kind === "managed") {
    if (format === "rpm") return `${base}-x86_64.rpm`;
    if (format === "deb") return `${base}-amd64.deb`;
    return "";
  }
  if (kind === "portable") return `${base}-x64.tar.gz`;
  return "";
}

export interface PackageInstaller {
  format: PackageFormat;
  platform: NodeJS.Platform;
  arch: string;
  downloadsDir(): string;
  // Opens the file with whatever the system uses for it.
  open(file: string): Promise<void>;
  // Shows the file in the file manager (an archive has no installer).
  reveal(file: string): void;
  fetchImpl?: typeof fetch;
}

// Empty for the kinds that self-update; shown next to "Update available"
// for the rest. The mac build would need signing before quitAndInstall can
// work, so it gets the download instruction for now.
const INSTRUCTIONS: Record<InstallKind, string> = {
  appimage: "",
  nsis: "",
  dev: "",
  flatpak: "Update with: flatpak update",
  snap: "Update with: snap refresh",
  managed: "Update through your package manager.",
  portable: "Download the latest version from the releases page on GitHub.",
  mac: "Download the latest version from the releases page on GitHub.",
};

// How was this build installed? Decides whether the app may replace itself.
// Sandbox and package-manager markers win over the path check because those
// environments still mount the binary under /usr. The linux fallthrough
// (a tar.gz unpacked anywhere) reads as "portable": notify-only, with the
// plain download instruction.
export function detectInstallKind(
  env: NodeJS.ProcessEnv,
  execPath: string,
  platform: NodeJS.Platform,
  packaged: boolean,
): InstallKind {
  if (!packaged) return "dev";
  if (env.APPIMAGE) return "appimage";
  if (env.FLATPAK_ID) return "flatpak";
  if (env.SNAP) return "snap";
  if (platform === "win32") return env.PORTABLE_EXECUTABLE_DIR ? "portable" : "nsis";
  if (platform === "darwin") return "mac";
  if (execPath.startsWith("/usr/") || execPath.startsWith("/opt/")) return "managed";
  return "portable";
}

// Plain numeric dotted compare; the release stream is x.y.z with no
// prerelease tags, so full semver rules would be dead weight.
export function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split(".").map((part) => parseInt(part, 10) || 0);
  const b = current.split(".").map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

// Release tags are "v0.9.0" or "0.9.0"; anything that is not a dotted
// version is not a release to offer.
export function versionFromTag(tag: unknown): string {
  if (typeof tag !== "string") return "";
  const bare = tag.trim().replace(/^v/i, "");
  return /^\d+(\.\d+)+$/.test(bare) ? bare : "";
}

export type LatestVersionFetcher = () => Promise<string>;

// The newest published release on GitHub, straight from the API. No token:
// the repo is public and one call per launch sits far under the anonymous
// rate limit. A 404 means no release has shipped yet, which is "nothing to
// update to" rather than a failure worth showing the player.
export async function fetchLatestReleaseVersion(fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(LATEST_RELEASE_API, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "open-dungeon-master-client" },
  });
  if (res.status === 404) return "";
  if (!res.ok) throw new Error(`GitHub answered ${res.status} while checking for updates.`);
  const body = (await res.json()) as { tag_name?: unknown };
  return versionFromTag(body.tag_name);
}

// Before the first release ships, the feed URL serves a 404. That is
// "nothing to update to", not a failure worth showing the player.
function isMissingFeed(err: unknown): boolean {
  const status = (err as { statusCode?: number } | null)?.statusCode;
  if (status === 404) return true;
  return err instanceof Error && /404/.test(err.message);
}

export class Updater {
  private readonly listeners = new Set<() => void>();
  private updater: AppUpdater | null = null;
  private startupChecked = false;
  private state: UpdateProgress = {
    state: "idle",
    percent: 0,
    latest: "",
    error: "",
    message: "",
    status: null,
  };

  constructor(
    readonly kind: InstallKind,
    private readonly currentVersion: string,
    private readonly fetchLatest: LatestVersionFetcher = fetchLatestReleaseVersion,
    private readonly startupDelayMs = STARTUP_CHECK_DELAY_MS,
    private readonly installer: PackageInstaller | null = null,
  ) {}

  private assetFor(version: string): string {
    if (!this.installer || this.canSelfUpdate()) return "";
    return packageAssetName(version, this.kind, this.installer.platform, this.installer.arch, this.installer.format);
  }

  onStatus(listener: () => void): void {
    this.listeners.add(listener);
  }

  progress(): UpdateProgress {
    return { ...this.state };
  }

  private setProgress(patch: Partial<UpdateProgress>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private canSelfUpdate(): boolean {
    return SELF_UPDATE_KINDS.has(this.kind);
  }

  private statusOf(latest: string, available: boolean): UpdateStatus {
    return {
      current: this.currentVersion,
      latest: latest || this.currentVersion,
      available,
      canSelfUpdate: this.canSelfUpdate(),
      canDownload: available && Boolean(this.assetFor(latest)),
      instruction: INSTRUCTIONS[this.kind],
      releasesUrl: RELEASES_URL,
    };
  }

  private async load(): Promise<AppUpdater> {
    if (this.updater) return this.updater;
    const { autoUpdater } = await import("electron-updater");
    // Downloads only ever start from an explicit player click.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on("download-progress", (info: ProgressInfo) => {
      this.setProgress({ state: "downloading", percent: Math.round(info.percent) });
    });
    this.updater = autoUpdater;
    return autoUpdater;
  }

  // What GitHub says is newest, compared against this build.
  private async checkGitHub(): Promise<UpdateStatus> {
    const latest = await this.fetchLatest();
    return this.statusOf(latest, Boolean(latest) && isNewerVersion(latest, this.currentVersion));
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    // A dev run has no app-update.yml and nothing meaningful to compare.
    if (this.kind === "dev") return this.statusOf(this.currentVersion, false);
    if (!this.canSelfUpdate()) return this.checkGitHub();
    const updater = await this.load();
    try {
      const result = await updater.checkForUpdates();
      // null is electron-updater declining to look (it did not recognise
      // the install), not an answer; ask GitHub instead of calling that
      // "up to date".
      if (!result) return this.checkGitHub();
      return this.statusOf(result.updateInfo.version, result.isUpdateAvailable);
    } catch (err) {
      if (isMissingFeed(err)) return this.statusOf(this.currentVersion, false);
      throw err;
    }
  }

  // The package route: one file from the release into Downloads, then the
  // system opens it. Nothing here needs root; the package installer asks for
  // what it needs.
  private async downloadPackage(): Promise<void> {
    const installer = this.installer;
    const status = await this.checkGitHub();
    const asset = status.available ? this.assetFor(status.latest) : "";
    if (!installer || !asset) {
      throw new Error(status.available ? INSTRUCTIONS[this.kind] || "This install cannot update itself." : "You already have the latest version.");
    }
    const { createWriteStream } = await import("node:fs");
    const { mkdir, rename, rm } = await import("node:fs/promises");
    const pathModule = await import("node:path");
    const folder = installer.downloadsDir();
    await mkdir(folder, { recursive: true });
    const target = pathModule.join(folder, asset);
    const partial = `${target}.part`;
    this.setProgress({ state: "downloading", percent: 0, latest: status.latest, error: "", message: "" });
    try {
      const res = await (installer.fetchImpl ?? fetch)(`https://github.com/${REPO}/releases/download/v${status.latest}/${asset}`, {
        headers: { "User-Agent": "open-dungeon-master-client" },
      });
      if (!res.ok || !res.body) throw new Error(`GitHub answered ${res.status} for ${asset}.`);
      const total = Number(res.headers.get("content-length")) || 0;
      const out = createWriteStream(partial);
      let done = 0;
      let shown = -1;
      const reader = res.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        done += chunk.value.byteLength;
        if (!out.write(chunk.value)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
        const percent = total ? Math.min(99, Math.floor((done / total) * 100)) : 0;
        if (percent !== shown) {
          shown = percent;
          this.setProgress({ state: "downloading", percent });
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      await rename(partial, target);
      const archive = asset.endsWith(".tar.gz");
      this.setProgress({
        state: "ready",
        percent: 100,
        message: archive
          ? `Version ${status.latest} is in your Downloads folder. Unpack it over the old one.`
          : `Version ${status.latest} is downloaded. Your system's installer is opening it; close this app when it asks.`,
      });
      if (archive) installer.reveal(target);
      else await installer.open(target);
    } catch (err) {
      await rm(partial, { force: true }).catch(() => undefined);
      this.setProgress({ state: "error", error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  async downloadAndInstall(): Promise<void> {
    if (!this.canSelfUpdate()) return this.downloadPackage();
    const updater = await this.load();
    try {
      // electron-updater only downloads what its own last check found, so
      // re-check here instead of trusting a stale renderer state.
      const result = await updater.checkForUpdates();
      if (!result || !result.isUpdateAvailable) {
        this.setProgress({ state: "idle", percent: 0, error: "" });
        throw new Error("You already have the latest version.");
      }
      this.setProgress({
        state: "downloading",
        percent: 0,
        latest: result.updateInfo.version,
        error: "",
      });
      await updater.downloadUpdate(result.cancellationToken);
      this.setProgress({ state: "ready", percent: 100 });
      updater.quitAndInstall();
    } catch (err) {
      if (this.state.state === "downloading" || this.state.state === "ready") {
        this.setProgress({
          state: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }

  // One quiet background check per app run; failures stay silent because the
  // player did not ask. The renderer hears about a hit via the progress
  // event, which carries the full status so it can offer the right button
  // (install here, or fetch it from GitHub) without asking again.
  checkOnStartup(): void {
    if (this.startupChecked || this.kind === "dev") return;
    this.startupChecked = true;
    setTimeout(() => {
      void this.checkForUpdates()
        .then((status) => {
          if (status.available) {
            this.setProgress({ state: "available", latest: status.latest, status });
          }
        })
        .catch(() => undefined);
    }, this.startupDelayMs);
  }
}
