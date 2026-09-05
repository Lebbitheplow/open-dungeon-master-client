// Everything the screens share: the remembered servers, the device world
// and its tunnel, the pending invite, app and update info, and the campaign
// feed. One mutable object rather than loose exports so any module can
// update a field and every other module reads the same value.
import type {
  AppInfo,
  ConnectResult,
  HomeFeed,
  LocalStatus,
  ServerSummary,
  TunnelStatus,
  UpdateStatus,
} from "../shared/types";

export interface JoinIntent {
  origin: string;
  code: string;
  knownServerId: string;
}

export const isAndroid = window.odm.platform === "android";

// The device's own world is the default door. On Android the world runs
// inside the app too (a bundled server), so the same card serves both, with
// the device named honestly.
export const DEVICE = isAndroid ? "This device" : "This computer";

export const state = {
  servers: [] as ServerSummary[],
  local: {
    state: "unavailable",
    origin: "",
    firstRun: true,
    hasAccount: false,
    username: "",
    serverVersion: "",
    error: "",
    lanOrigin: "",
  } as LocalStatus,
  tunnel: { state: "stopped", url: "", mode: "", error: "" } as TunnelStatus,
  joinIntent: null as JoinIntent | null,
  screenName: "home",
  appInfo: null as AppInfo | null,
  updateStatus: null as UpdateStatus | null,
  // One-line update state shown in the footer instead of the version.
  updateNote: "",
  // The last campaign feed, cached or fresh; null until the first answer.
  feed: null as HomeFeed | null,
  feedRefreshing: false,
};

export async function refresh(): Promise<void> {
  const data = await window.odm.listServers();
  state.servers = data.servers;
  state.local = data.local;
  state.tunnel = data.tunnel;
}

// Asks every host again. The result also arrives as a home-feed event, so
// callers only need this promise to know when the refresh has finished.
export async function refreshFeed(): Promise<void> {
  state.feedRefreshing = true;
  try {
    state.feed = await window.odm.homeFeed();
  } catch {
    // The event listener keeps the last feed; nothing to undo.
  } finally {
    state.feedRefreshing = false;
  }
}

// Doors into a host. Both bridge calls take an optional page so the home
// screen can land on a campaign, the character library or the workshop
// rather than the root; main sanitizes the path (src/shared/open-path.ts).
export function connectAt(
  serverId: string,
  joinCode: string | undefined,
  path: string,
): Promise<ConnectResult> {
  return window.odm.connect(serverId, joinCode, path || undefined);
}

export function localPlayAt(joinCode: string | undefined, path: string): Promise<ConnectResult> {
  return window.odm.localPlay(joinCode, path || undefined);
}

const HIDE_OFFLINE_KEY = "odm.home.hideOffline";

export function hideOffline(): boolean {
  try {
    return localStorage.getItem(HIDE_OFFLINE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setHideOffline(on: boolean): void {
  try {
    localStorage.setItem(HIDE_OFFLINE_KEY, on ? "1" : "0");
  } catch {
    // Storage can be denied; the toggle then only lasts the session.
  }
}
