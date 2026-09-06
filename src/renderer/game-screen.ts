// The shell's door into a host: the game screens drawn natively by the app
// (src/renderer/game) inside the shell's own page column, under its
// topbar and beside its menu. The game bundle is loaded on first use; a
// host too old to serve the app's own origin, or a page the native
// screens do not have, still opens in the web view as before.
import { landingPath } from "../shared/open-path.js";
import { nativeEligible } from "../shared/portal-logic.js";
import type { ShellShareStatus } from "../shared/types.js";
import { show } from "./chrome.js";
import { el } from "./dom.js";
import { renderHome } from "./home.js";
import { connectAt, localPlayAt, refresh, state, tunnelWatchers } from "./state.js";

interface GameMount {
  router: {
    location: { pathname: string; search: string };
    push(url: string): void;
    replace(url: string): void;
    back(): boolean;
    refresh(): void;
  };
  unmount(): void;
}

interface GameModule {
  mountDeviceSettings(root: HTMLElement): () => void;
  mountGame(
    root: HTMLElement,
    options: {
      session: { origin: string; token: string };
      path: string;
      onLeave(url: string): void;
    },
  ): GameMount;
}

// The window.odmShell contract the host's pages rely on inside the apps
// (the server's src/lib/shell-host.ts), served here by the shell itself.
interface ShellHostApi {
  platform: "desktop" | "android";
  showServers(): void;
  share: {
    status(): Promise<ShellShareStatus>;
    start(): Promise<ShellShareStatus>;
    stop(): Promise<ShellShareStatus>;
    subscribe(listener: (status: ShellShareStatus) => void): () => void;
  };
  shareLink?(input: { title: string; text: string; url: string }): Promise<boolean>;
  navigation: {
    location(): { pathname: string; search: string };
    push(url: string): void;
    replace(url: string): void;
    reload(): void;
  };
  hostOrigin: string;
}

const LOCAL = "local";
let mount: GameMount | null = null;
let mountedHost = "";
let bundle: Promise<GameModule> | null = null;

function loadBundle(): Promise<GameModule> {
  if (window.odmGame) return Promise.resolve(window.odmGame as GameModule);
  bundle ??= new Promise((resolve, reject) => {
    const style = el("link");
    style.rel = "stylesheet";
    style.href = "./game/game.css";
    document.head.append(style);
    const script = el("script");
    script.type = "module";
    script.src = "./game/game.js";
    script.addEventListener("load", () => {
      if (window.odmGame) resolve(window.odmGame as GameModule);
      else reject(new Error("The game screens did not load."));
    });
    script.addEventListener("error", () => reject(new Error("The game screens did not load.")));
    document.head.append(script);
  });
  return bundle;
}

export function isGameShowing(): boolean {
  return mount !== null;
}

// The audio and dice controls on the shell's Settings screen, drawn by the
// game bundle (loaded on first use). Resolves to the unmount.
export async function mountDeviceSettings(root: HTMLElement): Promise<() => void> {
  const game = await loadBundle();
  root.replaceChildren();
  return game.mountDeviceSettings(root);
}

// The shell's back gesture inside a world: the previous page, or false at
// the world's first page so the caller can leave for home.
export function gameBack(): boolean {
  return mount ? mount.router.back() : false;
}

// The game root's distance from the top of the window, for the CSS that
// sizes the table's full-height layout (home.css --game-top). Measured
// again when the window changes, since the safe area can move.
function measureTop(root: HTMLElement): void {
  const top = Math.round(root.getBoundingClientRect().top + window.scrollY);
  root.style.setProperty("--game-top", `${Math.max(0, top)}px`);
}

let resizeWatcher: (() => void) | null = null;

export function unmountGame(): void {
  if (!mount) return;
  mount.unmount();
  mount = null;
  mountedHost = "";
  if (resizeWatcher) {
    window.removeEventListener("resize", resizeWatcher);
    resizeWatcher = null;
  }
  delete (window as { odmShell?: unknown }).odmShell;
}

function goHome(): void {
  void refresh().then(() => renderHome());
}

// A page the native screens do not have, or an address off the host: the
// web view for the former (the old way in), the browser for the latter.
function leaveFor(hostId: string, url: string): void {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    window.open(url, "_blank", "noopener");
    return;
  }
  void (hostId === LOCAL ? localPlayAt(undefined, url) : connectAt(hostId, undefined, url));
}

function shareStatus(hostId: string): ShellShareStatus {
  const supported = hostId === LOCAL && state.local.state === "running";
  return { supported, ...state.tunnel, lanUrl: supported ? state.local.lanOrigin : "" };
}

function shellHostApi(hostId: string, origin: string, current: () => GameMount | null): ShellHostApi {
  const api: ShellHostApi = {
    platform: window.odm.platform,
    showServers: () => goHome(),
    share: {
      status: async () => shareStatus(hostId),
      async start() {
        if (hostId !== LOCAL) return shareStatus(hostId);
        const result = await window.odm.shareStart();
        await refresh().catch(() => undefined);
        const status = shareStatus(hostId);
        return result.ok ? status : { ...status, state: "error", error: result.error };
      },
      async stop() {
        if (hostId === LOCAL) {
          await window.odm.shareStop();
          await refresh().catch(() => undefined);
        }
        return shareStatus(hostId);
      },
      subscribe(listener) {
        const watcher = (): void => listener(shareStatus(hostId));
        tunnelWatchers.add(watcher);
        return () => tunnelWatchers.delete(watcher);
      },
    },
    navigation: {
      location: () => current()?.router.location ?? { pathname: "/", search: "" },
      push: (url) => current()?.router.push(url),
      replace: (url) => current()?.router.replace(url),
      reload: () => current()?.router.refresh(),
    },
    hostOrigin: origin,
  };
  if (window.odm.shareLink) {
    const share = window.odm.shareLink;
    api.shareLink = (input) => share(input);
  }
  return api;
}

// Draws the host natively at path. Returns false when the host is too old
// for it or the shell has no live session there; the caller then opens the
// web view the way it always did.
export async function tryOpenNative(hostId: string, path: string, serverVersion: string): Promise<boolean> {
  if (!nativeEligible(serverVersion).ok) return false;
  const session = await window.odm.hostSession(hostId);
  if (!session) return false;
  let game: GameModule;
  try {
    game = await loadBundle();
  } catch {
    return false;
  }
  unmountGame();
  state.screenName = "game";
  const root = el("div", "game-root");
  root.dataset.host = hostId;
  show("game", root);
  measureTop(root);
  resizeWatcher = () => measureTop(root);
  window.addEventListener("resize", resizeWatcher);
  (window as { odmShell?: ShellHostApi }).odmShell = shellHostApi(hostId, session.origin, () => mount);
  mount = game.mountGame(root, {
    session,
    path: path || "/",
    onLeave: (url) => {
      unmountGame();
      leaveFor(hostId, url);
    },
  });
  mountedHost = hostId;
  return true;
}

export function mountedHostId(): string {
  return mountedHost;
}

// The device world, natively: only once it has a profile and is awake.
export async function tryOpenNativeLocal(joinCode: string | undefined, path: string): Promise<boolean> {
  if (state.local.state === "unavailable" || state.local.firstRun || !state.local.hasAccount) return false;
  if (!nativeEligible(state.local.serverVersion).ok) return false;
  const started = await window.odm.localStart();
  if (!started.ok) return false;
  state.local = started.status;
  return tryOpenNative(LOCAL, landingPath(joinCode ?? "", path), started.status.serverVersion);
}
