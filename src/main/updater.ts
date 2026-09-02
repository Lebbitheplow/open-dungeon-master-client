import type { AppUpdater, ProgressInfo } from "electron-updater";
import type { InstallKind, UpdateProgress, UpdateStatus } from "../shared/types";

// Desktop updates against the GitHub Releases feed (electron-builder.yml
// publish block). Only AppImage and NSIS builds can swap themselves out;
// every other install channel owns its files (pacman, flatpak, the Mac
// bundle), so the app only tells the player where the new version lives.
//
// electron-updater drags in electron at require time, so it loads lazily
// inside the class: this module must stay importable under plain node for
// the detectInstallKind unit tests.

// Give the window time to appear before the one background check phones home.
const STARTUP_CHECK_DELAY_MS = 15_000;

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
  private state: UpdateProgress = { state: "idle", percent: 0, latest: "", error: "" };

  constructor(
    readonly kind: InstallKind,
    private readonly currentVersion: string,
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
      latest,
      available,
      canSelfUpdate: this.canSelfUpdate(),
      instruction: INSTRUCTIONS[this.kind],
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

  async checkForUpdates(): Promise<UpdateStatus> {
    // A dev run has no app-update.yml and nothing meaningful to compare.
    if (this.kind === "dev") return this.statusOf(this.currentVersion, false);
    const updater = await this.load();
    try {
      const result = await updater.checkForUpdates();
      if (!result) return this.statusOf(this.currentVersion, false);
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
  // player did not ask. The renderer hears about a hit via the progress event.
  checkOnStartup(): void {
    if (this.startupChecked || this.kind === "dev") return;
    this.startupChecked = true;
    setTimeout(() => {
      void this.checkForUpdates()
        .then((status) => {
          if (status.available) {
            this.setProgress({ state: "available", latest: status.latest });
          }
        })
        .catch(() => undefined);
    }, STARTUP_CHECK_DELAY_MS);
  }
}
