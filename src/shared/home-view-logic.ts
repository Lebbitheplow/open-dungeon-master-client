// Pure decisions behind the home screen: which campaign the hero continues,
// which host the quick tiles act on, how campaigns group under their hosts
// and what each row says. No DOM here so the rules can be tested on their
// own and read as one list.
import type { HomeCampaign, HomeFeed, HomeHost, LocalStatus } from "./types";

export interface ContinuePick {
  host: HomeHost;
  campaign: HomeCampaign;
}

// What tapping a campaign row does. "start" is the device world asleep: the
// tap wakes it, then opens the campaign. "signIn" is a host whose session
// lapsed. "blocked" cannot be continued from here right now.
export type RowAction = "open" | "start" | "signIn" | "blocked";

export interface CampaignRow {
  campaign: HomeCampaign;
  line: string;
  action: RowAction;
  // The one-line reason a blocked row shows in place of its status.
  reason: string;
}

export interface HostGroup {
  host: HomeHost;
  label: string;
  statusLabel: string;
  // "last seen 3h ago" for hosts that are not online, "" otherwise.
  lastSeen: string;
  rows: CampaignRow[];
}

const STATUS_RANK: Record<HomeCampaign["status"], number> = { active: 0, lobby: 1, ended: 2 };

function reachable(host: HomeHost): boolean {
  return host.status === "online" || host.status === "starting";
}

function byFreshness(a: HomeCampaign, b: HomeCampaign): number {
  const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (rank !== 0) return rank;
  return (b.updatedAt || "").localeCompare(a.updatedAt || "");
}

// The device world's process state is the truth about the local host; a
// cached feed may still remember it online from last time.
export function reconcileLocal(feed: HomeFeed, local: LocalStatus): HomeFeed {
  const status: HomeHost["status"] =
    local.state === "running"
      ? "online"
      : local.state === "starting"
        ? "starting"
        : local.state === "unavailable"
          ? "unavailable"
          : "offline";
  return {
    ...feed,
    hosts: feed.hosts.map((host) =>
      host.kind === "local" ? { ...host, status, username: local.username || host.username } : host,
    ),
  };
}

// The most recently updated campaign still in play on a host that can be
// reached, with active tables ahead of lobbies still gathering.
export function pickContinueCampaign(feed: HomeFeed): ContinuePick | null {
  let best: ContinuePick | null = null;
  for (const host of feed.hosts) {
    if (!reachable(host)) continue;
    for (const campaign of host.campaigns) {
      if (campaign.status === "ended") continue;
      if (!best || byFreshness(campaign, best.campaign) < 0) best = { host, campaign };
    }
  }
  return best;
}

// Where "New campaign", "Characters" and "Workshop" go: the hero's host,
// else the device world when this build has one, else the first online
// server (the feed lists hosts most recently used first).
export function pickPrimaryHost(feed: HomeFeed, hero: ContinuePick | null): HomeHost | null {
  if (hero) return hero.host;
  const local = feed.hosts.find((host) => host.kind === "local");
  if (local && local.status !== "unavailable") return local;
  return feed.hosts.find((host) => host.kind !== "local" && host.status === "online") ?? null;
}

export function campaignLine(campaign: HomeCampaign): string {
  if (campaign.status === "ended") return "Ended";
  const party = campaign.maxPlayers
    ? `${campaign.playerCount}/${campaign.maxPlayers}`
    : `${campaign.playerCount}`;
  const parts = [campaign.status === "active" ? "Active" : "Lobby", party];
  if (campaign.playingAs) parts.push(`playing as ${campaign.playingAs}`);
  return parts.join(" · ");
}

// The hero's one line under the title: who the player is there and how
// full the table is.
export function heroLine(campaign: HomeCampaign): string {
  const party = campaign.maxPlayers
    ? `${campaign.playerCount}/${campaign.maxPlayers}`
    : `${campaign.playerCount}`;
  if (campaign.playingAs) return `Playing as ${campaign.playingAs} · ${party} party`;
  return `${campaign.status === "active" ? "Active" : "Lobby"} · ${party}`;
}

export function hostLabel(host: HomeHost, deviceName: string): string {
  if (host.kind === "local") return deviceName;
  if (host.name) return host.name;
  try {
    return new URL(host.origin).host;
  } catch {
    return host.origin;
  }
}

export function hostStatusLabel(host: HomeHost): string {
  switch (host.status) {
    case "online":
      return "online";
    case "starting":
      return "starting";
    case "needsLogin":
      return "sign in";
    case "unavailable":
      return "unavailable";
    default:
      return "offline";
  }
}

export function blockedReason(host: HomeHost): string {
  return host.kind === "tunnel" ? "Hosted on another player's app" : "Server unreachable";
}

export function rowAction(host: HomeHost): RowAction {
  if (reachable(host)) return "open";
  if (host.kind === "local") return host.status === "unavailable" ? "blocked" : "start";
  if (host.status === "needsLogin") return "signIn";
  return "blocked";
}

// "3h ago" style, coarse on purpose: the point is whether it was today.
export function relativeTime(iso: string | null, now: number): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.round((now - then) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

export interface GroupOptions {
  hideOffline: boolean;
  deviceName: string;
  now: number;
}

// One group per host, in feed order. The device world always shows (a tap
// wakes it), a build without one never does, and "hide offline" drops the
// servers and tunnels that cannot be reached right now.
export function buildGroups(feed: HomeFeed, options: GroupOptions): HostGroup[] {
  const groups: HostGroup[] = [];
  for (const host of feed.hosts) {
    if (host.status === "unavailable") continue;
    if (options.hideOffline && host.kind !== "local" && host.status === "offline") continue;
    const action = rowAction(host);
    const reason = action === "blocked" ? blockedReason(host) : "";
    const rows = [...host.campaigns].sort(byFreshness).map((campaign) => ({
      campaign,
      line: campaignLine(campaign),
      action,
      reason,
    }));
    const seen = host.status === "online" ? "" : relativeTime(host.lastSeenAt, options.now);
    groups.push({
      host,
      label: hostLabel(host, options.deviceName),
      statusLabel: hostStatusLabel(host),
      lastSeen: seen ? `last seen ${seen}` : "",
      rows,
    });
  }
  return groups;
}
