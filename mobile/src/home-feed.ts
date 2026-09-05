import {
  CAMPAIGNS_PATH,
  HOME_FETCH_TIMEOUT_MS,
  LOCAL_HOST_ID,
  createHomeFeed,
  hostKindFor,
  type FetchOutcome,
  type HomeCache,
  type HomeFeedController,
  type HostInput,
} from "../../src/shared/home-feed-logic";
import type { LocalStatus, ShellEvent } from "../../src/shared/types";
import type { JsonReply } from "./share-tunnel";

// The Android shell's home feed: the shared orchestrator fed from the
// Preferences-backed server list and on-device profile, asking hosts over
// native HTTP (no CORS wall, plain-http LAN servers allowed). Mirrors the
// desktop shell's src/main/home-feed.ts.

export const HOME_CACHE_KEY = "odm-home-cache";

// A saved server as bridge.ts keeps it, with token already "" when expired.
export interface HomeServerSource {
  id: string;
  origin: string;
  name: string;
  username: string;
  lastUsedAt: string;
  token: string;
}

export interface AndroidHomeFeedDeps {
  servers(): Promise<HomeServerSource[]>;
  localStatus(): Promise<LocalStatus>;
  // The on-device profile's live token, "" when there is none.
  localToken(): Promise<string>;
  fetchJson(
    url: string,
    init?: { headers?: Record<string, string>; timeoutMs?: number },
  ): Promise<JsonReply>;
  getPref(key: string): Promise<string | null>;
  setPref(key: string, value: string): Promise<void>;
  emit(event: ShellEvent): void;
  now?(): string;
}

export function createAndroidHomeFeed(deps: AndroidHomeFeedDeps): HomeFeedController {
  async function fetchCampaigns(origin: string, token: string): Promise<FetchOutcome> {
    try {
      const reply = await deps.fetchJson(`${origin}${CAMPAIGNS_PATH}`, {
        headers: { authorization: `Bearer ${token}` },
        timeoutMs: HOME_FETCH_TIMEOUT_MS,
      });
      return { kind: "reply", status: reply.status, body: reply.data };
    } catch {
      return { kind: "failed", error: `Could not reach ${origin}.` };
    }
  }

  async function hosts(): Promise<HostInput[]> {
    const [local, token, servers] = await Promise.all([
      deps.localStatus(),
      deps.localToken(),
      deps.servers(),
    ]);
    const list: HostInput[] = [
      {
        id: LOCAL_HOST_ID,
        kind: "local",
        name: "This device",
        origin: local.origin,
        username: local.username,
        lastUsedAt: "",
        token,
      },
    ];
    for (const server of servers) {
      list.push({
        id: server.id,
        kind: hostKindFor(server.origin),
        name: server.name,
        origin: server.origin,
        username: server.username,
        lastUsedAt: server.lastUsedAt,
        token: server.token,
      });
    }
    return list;
  }

  async function loadCache(): Promise<HomeCache> {
    try {
      const raw = await deps.getPref(HOME_CACHE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as HomeCache)
        : {};
    } catch {
      return {};
    }
  }

  return createHomeFeed({
    hosts,
    localStatus: deps.localStatus,
    fetchCampaigns,
    loadCache,
    saveCache: (cache) => deps.setPref(HOME_CACHE_KEY, JSON.stringify(cache)),
    emit: deps.emit,
    now: deps.now ?? (() => new Date().toISOString()),
  });
}
