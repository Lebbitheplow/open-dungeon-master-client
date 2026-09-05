import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGroups,
  campaignLine,
  heroLine,
  pickContinueCampaign,
  pickPrimaryHost,
  reconcileLocal,
  relativeTime,
  rowAction,
} from "../dist/shared/home-view-logic.js";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");

function campaign(overrides = {}) {
  return {
    id: "c1",
    title: "The Sunless Citadel",
    status: "active",
    playerCount: 4,
    maxPlayers: 5,
    playingAs: "Kaleb",
    coverUrl: null,
    updatedAt: "2026-09-03T12:00:00.000Z",
    role: "player",
    dmMode: "ai",
    ...overrides,
  };
}

function host(overrides = {}) {
  return {
    id: "srv",
    kind: "server",
    name: "play.mytable.net",
    origin: "https://play.mytable.net",
    username: "kaleb",
    status: "online",
    lastSeenAt: "2026-09-04T11:00:00.000Z",
    stale: false,
    error: "",
    campaigns: [],
    ...overrides,
  };
}

const local = (overrides = {}) =>
  host({ id: "local", kind: "local", name: "", origin: "http://127.0.0.1:3210", ...overrides });

const feed = (hosts) => ({ hosts, refreshedAt: "2026-09-04T12:00:00.000Z" });

test("continue picks the freshest active campaign on a reachable host, lobbies after", () => {
  const picked = pickContinueCampaign(
    feed([
      local({
        campaigns: [
          campaign({ id: "lobby", status: "lobby", updatedAt: "2026-09-04T11:59:00.000Z" }),
          campaign({ id: "older", updatedAt: "2026-09-01T00:00:00.000Z" }),
        ],
      }),
      host({ campaigns: [campaign({ id: "fresh", updatedAt: "2026-09-03T00:00:00.000Z" })] }),
      host({
        id: "down",
        status: "offline",
        campaigns: [campaign({ id: "unreachable", updatedAt: "2026-09-04T12:00:00.000Z" })],
      }),
    ]),
  );
  assert.equal(picked.campaign.id, "fresh");
  assert.equal(picked.host.id, "srv");

  // No active table anywhere: the newest lobby wins. Ended ones never do.
  const lobby = pickContinueCampaign(
    feed([
      local({
        status: "starting",
        campaigns: [
          campaign({ id: "done", status: "ended", updatedAt: "2026-09-04T12:00:00.000Z" }),
          campaign({ id: "gathering", status: "lobby" }),
        ],
      }),
    ]),
  );
  assert.equal(lobby.campaign.id, "gathering");
  assert.equal(pickContinueCampaign(feed([host({ status: "needsLogin", campaigns: [campaign()] })])), null);
  assert.equal(pickContinueCampaign(feed([])), null);
});

test("the primary host is the hero's, else the device world, else the first online server", () => {
  const hero = { host: host({ id: "hero" }), campaign: campaign() };
  assert.equal(pickPrimaryHost(feed([local()]), hero).id, "hero");
  assert.equal(pickPrimaryHost(feed([host(), local({ status: "offline" })]), null).id, "local");
  assert.equal(
    pickPrimaryHost(feed([local({ status: "unavailable" }), host({ id: "a", status: "offline" }), host({ id: "b" })]), null).id,
    "b",
  );
  assert.equal(pickPrimaryHost(feed([host({ status: "offline" })]), null), null);
});

test("status lines read like the mockup", () => {
  assert.equal(campaignLine(campaign({ playerCount: 5, maxPlayers: 5 })), "Active · 5/5 · playing as Kaleb");
  assert.equal(campaignLine(campaign({ status: "lobby", playerCount: 1, maxPlayers: 6, playingAs: null })), "Lobby · 1/6");
  assert.equal(campaignLine(campaign({ status: "ended" })), "Ended");
  assert.equal(campaignLine(campaign({ maxPlayers: 0, playerCount: 2, playingAs: null })), "Active · 2");
  assert.equal(heroLine(campaign()), "Playing as Kaleb · 4/5 party");
  assert.equal(heroLine(campaign({ status: "lobby", playingAs: null, playerCount: 1, maxPlayers: 6 })), "Lobby · 1/6");
});

test("relative time is coarse and never in the future", () => {
  assert.equal(relativeTime(null, NOW), "");
  assert.equal(relativeTime("garbage", NOW), "");
  assert.equal(relativeTime("2026-09-04T11:59:40.000Z", NOW), "just now");
  assert.equal(relativeTime("2026-09-04T11:35:00.000Z", NOW), "25m ago");
  assert.equal(relativeTime("2026-09-04T09:00:00.000Z", NOW), "3h ago");
  assert.equal(relativeTime("2026-09-02T12:00:00.000Z", NOW), "2d ago");
  assert.equal(relativeTime("2026-09-04T13:00:00.000Z", NOW), "just now");
});

test("rows act by host: open, wake the device, sign in, or nothing", () => {
  assert.equal(rowAction(host()), "open");
  assert.equal(rowAction(host({ status: "starting" })), "open");
  assert.equal(rowAction(local({ status: "offline" })), "start");
  assert.equal(rowAction(local({ status: "unavailable" })), "blocked");
  assert.equal(rowAction(host({ status: "needsLogin" })), "signIn");
  assert.equal(rowAction(host({ status: "offline" })), "blocked");
  assert.equal(rowAction(host({ kind: "tunnel", status: "offline" })), "blocked");
});

test("groups follow the feed, sort rows, label status and explain what cannot continue", () => {
  const hosts = feed([
    local({
      status: "offline",
      lastSeenAt: "2026-09-04T09:00:00.000Z",
      campaigns: [
        campaign({ id: "ended", status: "ended", updatedAt: "2026-09-04T11:00:00.000Z" }),
        campaign({ id: "lobby", status: "lobby" }),
        campaign({ id: "active" }),
      ],
    }),
    host({ campaigns: [campaign({ id: "vault", title: "Emerald Vault", playerCount: 5, maxPlayers: 5 })] }),
    host({
      id: "dave",
      kind: "tunnel",
      name: "Dave's table",
      status: "offline",
      stale: true,
      lastSeenAt: "2026-09-04T09:00:00.000Z",
      campaigns: [campaign({ id: "frost", title: "Frostspire Saga" })],
    }),
    host({ id: "locked", status: "needsLogin", lastSeenAt: null, campaigns: [campaign({ id: "l" })] }),
    local({ id: "none", status: "unavailable" }),
  ]);
  const groups = buildGroups(hosts, { hideOffline: false, deviceName: "This device", now: NOW });
  assert.deepEqual(
    groups.map((group) => [group.label, group.statusLabel, group.lastSeen]),
    [
      ["This device", "offline", "last seen 3h ago"],
      ["play.mytable.net", "online", ""],
      ["Dave's table", "offline", "last seen 3h ago"],
      ["play.mytable.net", "sign in", ""],
    ],
  );
  // Active, then lobby, then ended; the device world's rows wake it.
  assert.deepEqual(
    groups[0].rows.map((row) => [row.campaign.id, row.action]),
    [["active", "start"], ["lobby", "start"], ["ended", "start"]],
  );
  assert.deepEqual(groups[1].rows.map((row) => row.line), ["Active · 5/5 · playing as Kaleb"]);
  assert.equal(groups[2].rows[0].action, "blocked");
  assert.equal(groups[2].rows[0].reason, "Hosted on another player's app");
  assert.equal(groups[3].rows[0].action, "signIn");

  const offlineServer = buildGroups(
    feed([host({ status: "offline", campaigns: [campaign()] })]),
    { hideOffline: false, deviceName: "This device", now: NOW },
  );
  assert.equal(offlineServer[0].rows[0].reason, "Server unreachable");

  // Hide offline keeps the device world and the host that only needs a sign-in.
  const hidden = buildGroups(hosts, { hideOffline: true, deviceName: "This device", now: NOW });
  assert.deepEqual(hidden.map((group) => group.host.id), ["local", "srv", "locked"]);
});

test("the device world's live state overrides what the cached feed remembers", () => {
  const cached = feed([local({ status: "online", username: "old" }), host()]);
  const base = { origin: "", firstRun: false, hasAccount: true, username: "kaleb", serverVersion: "", error: "", lanOrigin: "" };
  assert.equal(reconcileLocal(cached, { ...base, state: "stopped" }).hosts[0].status, "offline");
  assert.equal(reconcileLocal(cached, { ...base, state: "starting" }).hosts[0].status, "starting");
  assert.equal(reconcileLocal(cached, { ...base, state: "running" }).hosts[0].status, "online");
  assert.equal(reconcileLocal(cached, { ...base, state: "running" }).hosts[0].username, "kaleb");
  assert.equal(reconcileLocal(cached, { ...base, state: "unavailable" }).hosts[0].status, "unavailable");
  assert.equal(reconcileLocal(cached, { ...base, state: "error" }).hosts[1].status, "online");
});
