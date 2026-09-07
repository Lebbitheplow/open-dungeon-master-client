import {
  CAMPAIGNS_PATH,
  COVER_MAX_BYTES,
  HOME_FETCH_TIMEOUT_MS,
  createHomeFeed,
  hostKindFor,
  imageDataUrl,
  type FetchOutcome,
  type HomeFeedController,
  type HostInput,
} from "../shared/home-feed-logic";
import type { LocalStatus, ShellEvent } from "../shared/types";
import { LOCAL_SERVER_ID, type ServerStore } from "./servers";

// The desktop shell's home feed: the shared orchestrator fed from the
// servers registry (hosts, tokens, cache) and the local world's status.
// No Electron import here so the module runs under plain Node in tests.

export async function fetchCampaigns(origin: string, token: string): Promise<FetchOutcome> {
  try {
    const res = await fetch(`${origin}${CAMPAIGNS_PATH}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(HOME_FETCH_TIMEOUT_MS),
    });
    return { kind: "reply", status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { kind: "failed", error: `Could not reach ${origin}.` };
  }
}

// One cover as a data URL, or "" for anything but an image answered with
// 200 within the size cap. url must already have passed coverRequestUrl.
export async function fetchCoverImage(url: string, token: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(HOME_FETCH_TIMEOUT_MS),
    });
    if (res.status !== 200) return "";
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > COVER_MAX_BYTES) return "";
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength > COVER_MAX_BYTES) return "";
    return imageDataUrl(res.headers.get("content-type") ?? "", bytes.toString("base64")) ?? "";
  } catch {
    return "";
  }
}

export interface DesktopHomeFeedDeps {
  store: ServerStore;
  localStatus(): LocalStatus;
  emit(event: ShellEvent): void;
  fetchCampaigns?(origin: string, token: string): Promise<FetchOutcome>;
  now?(): string;
  // Supplied by the shell (it owns the probe and the broker calls): where a
  // quiet host is now, or "". The registry entry is moved as a side effect.
  relocate?(input: HostInput): Promise<string>;
}

export function createDesktopHomeFeed(deps: DesktopHomeFeedDeps): HomeFeedController {
  const { store } = deps;

  const hosts = async (): Promise<HostInput[]> => {
    const local = deps.localStatus();
    const localEntry = store.get(LOCAL_SERVER_ID);
    const list: HostInput[] = [
      {
        id: LOCAL_SERVER_ID,
        kind: "local",
        name: localEntry?.name || "This computer",
        // "" unless the world is running; the orchestrator never asks then.
        origin: local.origin,
        username: local.username,
        lastUsedAt: localEntry?.lastUsedAt ?? "",
        token: store.token(LOCAL_SERVER_ID) ?? "",
      },
    ];
    for (const server of store.list()) {
      list.push({
        id: server.id,
        kind: hostKindFor(server.origin),
        name: server.name,
        origin: server.origin,
        username: server.username,
        lastUsedAt: server.lastUsedAt,
        token: store.token(server.id) ?? "",
      });
    }
    return list;
  };

  return createHomeFeed({
    hosts,
    localStatus: async () => deps.localStatus(),
    fetchCampaigns: deps.fetchCampaigns ?? fetchCampaigns,
    loadCache: async () => store.homeCache(),
    saveCache: async (cache) => store.saveHomeCache(cache),
    emit: deps.emit,
    now: deps.now ?? (() => new Date().toISOString()),
    ...(deps.relocate ? { relocate: deps.relocate } : {}),
  });
}
