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

// Give the window time to appear before the one background check phones home.
const STARTUP_CHECK_DELAY_MS = 15_000;

const REPO = "Lebbitheplow/open-dungeon-master-client";
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

const SELF_UPDATE_KINDS: ReadonlySet<InstallKind> = new Set(["appimage", "nsis"]);

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
    status: null,
  };

  constructor(
    readonly kind: InstallKind,
    private readonly currentVersion: string,
    private readonly fetchLatest: LatestVersionFetcher = fetchLatestReleaseVersion,
    private readonly startupDelayMs = STARTUP_CHECK_DELAY_MS,
  ) {}

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

  async downloadAndInstall(): Promise<void> {
    if (!this.canSelfUpdate()) {
      throw new Error(INSTRUCTIONS[this.kind] || "This install cannot update itself.");
    }
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
