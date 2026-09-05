import { BROKER_HOST_SHAPE } from "./broker";
import type { HomeCampaign, HomeFeed, HomeHost, LocalStatus, ShellEvent } from "./types";

// The home screen's campaign feed: every host the player uses (the device
// world, saved servers, friends' apps reached through a tunnel), each with
// its campaigns. Pure helpers and an orchestrator with injected I/O, shared
// by the desktop main process (src/main/home-feed.ts) and the Android
// bridge (mobile/src/home-feed.ts), so it all runs under plain Node in tests.

export const CAMPAIGNS_PATH = "/api/campaigns";
// The device world's host id on both shells (the desktop registry's
// LOCAL_SERVER_ID has the same value).
export const LOCAL_HOST_ID = "local";
// A host that has not answered in this long is shown from its cache.
export const HOME_FETCH_TIMEOUT_MS = 6_000;

// Quick tunnels are anonymous trycloudflare addresses (src/shared/broker.ts
// has the named play-CODE shape). Both mean "another player's app".
const QUICK_HOST_SHAPE = /^[a-z0-9-]+\.trycloudflare\.com$/;

export function isTunnelOrigin(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return BROKER_HOST_SHAPE.test(host) || QUICK_HOST_SHAPE.test(host);
}

export function hostKindFor(origin: string): "server" | "tunnel" {
  return isTunnelOrigin(origin) ? "tunnel" : "server";
}

// One host as the shell knows it before any request goes out. token is ""
// when the shell holds no live session for it.
export interface HostInput {
  id: string;
  kind: HomeHost["kind"];
  name: string;
  origin: string;
  username: string;
  lastUsedAt: string;
  token: string;
}

// What the persisted store keeps per host: the last list that came back
// and when, plus the status seen then so a cold start can show something
// before the first refresh lands.
export interface HomeCacheEntry {
  status: HomeHost["status"];
  campaigns: HomeCampaign[];
  lastSeenAt: string | null;
}

export type HomeCache = Record<string, HomeCacheEntry>;

export type SkippedOutcome = {
  kind: "skipped";
  status: Exclude<HomeHost["status"], "online">;
  error: string;
};

// How a host's request ended: an HTTP answer, no answer at all, or no
// request because the shell already knew the answer.
export type FetchOutcome =
  | { kind: "reply"; status: number; body: unknown }
  | { kind: "failed"; error: string }
  | SkippedOutcome;

export const NEEDS_LOGIN: SkippedOutcome = { kind: "skipped", status: "needsLogin", error: "" };

// The local world's process state decides its host status without a
// request; null means it is running and should be asked like any server.
export function localOutcome(status: LocalStatus): SkippedOutcome | null {
  switch (status.state) {
    case "running":
      return null;
    case "starting":
      return { kind: "skipped", status: "starting", error: "" };
    case "unavailable":
      return { kind: "skipped", status: "unavailable", error: "" };
    case "error":
      return { kind: "skipped", status: "offline", error: status.error };
    default:
      return { kind: "skipped", status: "offline", error: "" };
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

// Covers come back host-relative (/uploads/...); the feed mixes hosts, so
// each cover is pinned to the host it came from.
function absoluteUrl(raw: string, origin: string): string | null {
  if (!raw) return null;
  try {
    return new URL(raw, origin).href;
  } catch {
    return null;
  }
}

// The server's GET /api/campaigns body. Returns null when the body is not a
// campaign list at all; entries without an id are dropped rather than
// failing the whole host. cover and playingAs are newer fields and optional.
export function parseCampaigns(body: unknown, origin: string): HomeCampaign[] | null {
  const list = (body as { campaigns?: unknown } | null)?.campaigns;
  if (!Array.isArray(list)) return null;
  const campaigns: HomeCampaign[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const id = str(entry.id);
    if (!id) continue;
    const settings = entry.gameSettings as { dmMode?: unknown } | null | undefined;
    const cover = entry.cover as { url?: unknown } | null | undefined;
    campaigns.push({
      id,
      title: str(entry.title) || "Untitled campaign",
      status: pick(entry.status, ["lobby", "active", "ended"] as const, "lobby"),
      playerCount: num(entry.playerCount),
      maxPlayers: num(entry.maxPlayers),
      playingAs: str(entry.playingAs) || null,
      coverUrl: absoluteUrl(str(cover?.url), origin),
      updatedAt: str(entry.updatedAt),
      role: pick(entry.role, ["owner", "player"] as const, "player"),
      dmMode: pick(settings?.dmMode, ["ai", "assisted", "human"] as const, "ai"),
    });
  }
  return campaigns;
}

export interface Classification {
  status: HomeHost["status"];
  // null when nothing fresh came back; the caller falls back to its cache.
  campaigns: HomeCampaign[] | null;
  error: string;
}

export function classifyOutcome(outcome: FetchOutcome, origin: string): Classification {
  if (outcome.kind === "skipped") return { status: outcome.status, campaigns: null, error: outcome.error };
  if (outcome.kind === "failed") return { status: "offline", campaigns: null, error: outcome.error };
  if (outcome.status === 401 || outcome.status === 403) {
    return { status: "needsLogin", campaigns: null, error: "" };
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    return { status: "offline", campaigns: null, error: `${origin} answered ${outcome.status}.` };
  }
  const campaigns = parseCampaigns(outcome.body, origin);
  if (!campaigns) {
    return {
      status: "offline",
      campaigns: null,
      error: `${origin} did not answer with a campaign list.`,
    };
  }
  return { status: "online", campaigns, error: "" };
}

// Fresh data wins; otherwise the cached list is shown and marked stale.
// stale is simply "not from this refresh", so an unreachable host with no
// cache is stale and empty rather than pretending to be current.
export function resolveHost(
  input: HostInput,
  outcome: FetchOutcome,
  cached: HomeCacheEntry | null,
  now: string,
): HomeHost {
  const result = classifyOutcome(outcome, input.origin);
  const fresh = result.campaigns !== null;
  return {
    id: input.id,
    kind: input.kind,
    name: input.name,
    origin: input.origin,
    username: input.username,
    status: result.status,
    lastSeenAt: fresh ? now : (cached?.lastSeenAt ?? null),
    stale: !fresh,
    error: result.error,
    campaigns: result.campaigns ?? cached?.campaigns ?? [],
  };
}

// The instant view before any request: whatever the store remembers. The
// local world's process state is known without asking, so it overrides
// the remembered status.
export function hostFromCache(
  input: HostInput,
  cached: HomeCacheEntry | null,
  status?: HomeHost["status"],
): HomeHost {
  return {
    id: input.id,
    kind: input.kind,
    name: input.name,
    origin: input.origin,
    username: input.username,
    status: status ?? cached?.status ?? (input.token ? "offline" : "needsLogin"),
    lastSeenAt: cached?.lastSeenAt ?? null,
    stale: true,
    error: "",
    campaigns: cached?.campaigns ?? [],
  };
}

export function cacheEntryFor(host: HomeHost): HomeCacheEntry {
  return { status: host.status, campaigns: host.campaigns, lastSeenAt: host.lastSeenAt };
}

// The device world leads; everything else follows in the order the player
// last used it.
export function orderHosts<T extends { kind: HomeHost["kind"]; lastUsedAt: string }>(
  hosts: readonly T[],
): T[] {
  return [...hosts].sort((a, b) => {
    if (a.kind === "local" !== (b.kind === "local")) return a.kind === "local" ? -1 : 1;
    return b.lastUsedAt.localeCompare(a.lastUsedAt);
  });
}

export interface HomeFeedDeps {
  // Every host including the local one, in any order.
  hosts(): Promise<HostInput[]>;
  localStatus(): Promise<LocalStatus>;
  fetchCampaigns(origin: string, token: string): Promise<FetchOutcome>;
  loadCache(): Promise<HomeCache>;
  saveCache(cache: HomeCache): Promise<void>;
  emit(event: ShellEvent): void;
  now(): string;
}

export interface HomeFeedController {
  // Asks every host in parallel, updates the cache, pushes a home-feed event.
  refresh(): Promise<HomeFeed>;
  // The last refresh of this run, or the persisted cache before one exists
  // (refreshedAt is "" then).
  cached(): Promise<HomeFeed>;
}

export function createHomeFeed(deps: HomeFeedDeps): HomeFeedController {
  let last: HomeFeed | null = null;
  let inFlight: Promise<HomeFeed> | null = null;
  let again = false;

  async function outcomeFor(input: HostInput, local: LocalStatus): Promise<FetchOutcome> {
    if (input.kind === "local") {
      const skip = localOutcome(local);
      if (skip) return skip;
    }
    if (!input.token) return NEEDS_LOGIN;
    if (!input.origin) return { kind: "failed", error: "This host has no address." };
    return deps.fetchCampaigns(input.origin, input.token);
  }

  async function build(): Promise<HomeFeed> {
    const now = deps.now();
    const [inputs, local, cache] = await Promise.all([
      deps.hosts(),
      deps.localStatus(),
      deps.loadCache(),
    ]);
    const hosts = await Promise.all(
      orderHosts(inputs).map(async (input) =>
        resolveHost(input, await outcomeFor(input, local), cache[input.id] ?? null, now),
      ),
    );
    // Rewriting the whole record also drops hosts the player has removed.
    const next: HomeCache = {};
    for (const host of hosts) next[host.id] = cacheEntryFor(host);
    await deps.saveCache(next).catch(() => undefined);
    const feed: HomeFeed = { hosts, refreshedAt: now };
    last = feed;
    deps.emit({ kind: "home-feed", feed });
    return feed;
  }

  // One refresh at a time. A request that lands mid-flight (the local world
  // just came up) is answered with the running one and queues another, so
  // the state that triggered it is never missed.
  function refresh(): Promise<HomeFeed> {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = build().finally(() => {
      inFlight = null;
      if (again) {
        again = false;
        refresh().catch(() => undefined);
      }
    });
    return inFlight;
  }

  async function cached(): Promise<HomeFeed> {
    if (last) return last;
    const [inputs, local, cache] = await Promise.all([
      deps.hosts(),
      deps.localStatus(),
      deps.loadCache(),
    ]);
    const hosts = orderHosts(inputs).map((input) =>
      hostFromCache(
        input,
        cache[input.id] ?? null,
        input.kind === "local" ? localOutcome(local)?.status : undefined,
      ),
    );
    return { hosts, refreshedAt: "" };
  }

  return { refresh, cached };
}
