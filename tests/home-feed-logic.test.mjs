import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyOutcome,
  createHomeFeed,
  hostFromCache,
  hostKindFor,
  isTunnelOrigin,
  localOutcome,
  orderHosts,
  parseCampaigns,
  resolveHost,
} from "../dist/shared/home-feed-logic.js";

const origin = "https://play.example";

function host(overrides = {}) {
  return {
    id: "srv",
    kind: "server",
    name: "Play",
    origin,
    username: "kaleb",
    lastUsedAt: "2026-09-01T00:00:00.000Z",
    token: "tok",
    ...overrides,
  };
}

const rawCampaign = {
  id: "c1",
  title: "The Sunken Keep",
  status: "active",
  playerCount: 3,
  maxPlayers: 5,
  updatedAt: "2026-09-03T12:00:00.000Z",
  role: "owner",
  gameSettings: { dmMode: "assisted" },
  cover: { url: "/uploads/keep.png" },
  playingAs: "Ser Vell",
};

function campaign(overrides = {}) {
  return {
    id: "c1",
    title: "The Sunken Keep",
    status: "active",
    playerCount: 3,
    maxPlayers: 5,
    playingAs: "Ser Vell",
    coverUrl: `${origin}/uploads/keep.png`,
    updatedAt: "2026-09-03T12:00:00.000Z",
    role: "owner",
    dmMode: "assisted",
    ...overrides,
  };
}

test("tunnel hosts are the play-CODE and trycloudflare addresses", () => {
  assert.equal(isTunnelOrigin("https://play-abcd1234.opendungeonmaster.com"), true);
  assert.equal(isTunnelOrigin("https://PLAY-ABCD1234.opendungeonmaster.com"), true);
  assert.equal(isTunnelOrigin("https://quiet-owl-42.trycloudflare.com"), true);
  assert.equal(isTunnelOrigin("https://dungeon.example.org"), false);
  assert.equal(isTunnelOrigin("http://192.168.1.50:3005"), false);
  assert.equal(isTunnelOrigin("https://play-abcd.opendungeonmaster.com.evil.example"), false);
  assert.equal(isTunnelOrigin("not a url"), false);
  assert.equal(hostKindFor("https://play-abcd1234.opendungeonmaster.com"), "tunnel");
  assert.equal(hostKindFor("https://dungeon.example.org"), "server");
});

test("a campaign list is parsed, covers pinned to the host, new fields optional", () => {
  const parsed = parseCampaigns({ campaigns: [rawCampaign] }, origin);
  assert.deepEqual(parsed, [campaign()]);
  const bare = parseCampaigns(
    { campaigns: [{ id: "c2", title: "Bare", status: "lobby", role: "player" }] },
    origin,
  );
  assert.deepEqual(bare, [
    campaign({
      id: "c2",
      title: "Bare",
      status: "lobby",
      playerCount: 0,
      maxPlayers: 0,
      playingAs: null,
      coverUrl: null,
      updatedAt: "",
      role: "player",
      dmMode: "ai",
    }),
  ]);
  // Absolute covers pass through; entries without an id are dropped.
  const mixed = parseCampaigns(
    { campaigns: [{ ...rawCampaign, cover: { url: "https://cdn.example/x.png" } }, { title: "no id" }, null] },
    origin,
  );
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].coverUrl, "https://cdn.example/x.png");
  // Not a list at all: null, so the caller knows to fall back to its cache.
  assert.equal(parseCampaigns({ error: "nope" }, origin), null);
  assert.equal(parseCampaigns(null, origin), null);
});

test("responses classify: 401/403 need login, failures are offline, 2xx is online", () => {
  assert.equal(classifyOutcome({ kind: "reply", status: 401, body: null }, origin).status, "needsLogin");
  assert.equal(classifyOutcome({ kind: "reply", status: 403, body: null }, origin).status, "needsLogin");
  const failed = classifyOutcome({ kind: "failed", error: "Could not reach it." }, origin);
  assert.equal(failed.status, "offline");
  assert.equal(failed.error, "Could not reach it.");
  const broken = classifyOutcome({ kind: "reply", status: 500, body: null }, origin);
  assert.equal(broken.status, "offline");
  assert.match(broken.error, /answered 500/);
  const odd = classifyOutcome({ kind: "reply", status: 200, body: { hello: 1 } }, origin);
  assert.equal(odd.status, "offline");
  const online = classifyOutcome(
    { kind: "reply", status: 200, body: { campaigns: [rawCampaign] } },
    origin,
  );
  assert.equal(online.status, "online");
  assert.equal(online.campaigns.length, 1);
  const skipped = classifyOutcome({ kind: "skipped", status: "starting", error: "" }, origin);
  assert.equal(skipped.status, "starting");
});

test("the local world's process state maps to a host status without a request", () => {
  const base = { origin: "", firstRun: false, hasAccount: true, username: "k", serverVersion: "", error: "", lanOrigin: "" };
  assert.equal(localOutcome({ ...base, state: "running" }), null);
  assert.equal(localOutcome({ ...base, state: "starting" }).status, "starting");
  assert.equal(localOutcome({ ...base, state: "stopped" }).status, "offline");
  assert.equal(localOutcome({ ...base, state: "unavailable" }).status, "unavailable");
  const crashed = localOutcome({ ...base, state: "error", error: "It died." });
  assert.equal(crashed.status, "offline");
  assert.equal(crashed.error, "It died.");
});

test("a fresh answer replaces the cache; an unreachable host keeps it, marked stale", () => {
  const now = "2026-09-04T10:00:00.000Z";
  const cached = {
    status: "online",
    campaigns: [campaign({ id: "old", title: "Old" })],
    lastSeenAt: "2026-09-03T00:00:00.000Z",
  };
  const fresh = resolveHost(
    host(),
    { kind: "reply", status: 200, body: { campaigns: [rawCampaign] } },
    cached,
    now,
  );
  assert.equal(fresh.status, "online");
  assert.equal(fresh.stale, false);
  assert.equal(fresh.lastSeenAt, now);
  assert.deepEqual(fresh.campaigns, [campaign()]);

  const down = resolveHost(host(), { kind: "failed", error: "gone" }, cached, now);
  assert.equal(down.status, "offline");
  assert.equal(down.stale, true);
  assert.equal(down.lastSeenAt, "2026-09-03T00:00:00.000Z");
  assert.deepEqual(down.campaigns, cached.campaigns);
  assert.equal(down.error, "gone");

  // Login needed still shows what the player had there.
  const locked = resolveHost(host(), { kind: "reply", status: 401, body: null }, cached, now);
  assert.equal(locked.status, "needsLogin");
  assert.deepEqual(locked.campaigns, cached.campaigns);

  // Nothing cached and nothing fresh: stale and empty, never invented.
  const empty = resolveHost(host(), { kind: "failed", error: "gone" }, null, now);
  assert.equal(empty.stale, true);
  assert.deepEqual(empty.campaigns, []);
  assert.equal(empty.lastSeenAt, null);
});

test("the cached view reports the remembered status unless the caller knows better", () => {
  const cached = { status: "online", campaigns: [campaign()], lastSeenAt: "2026-09-03T00:00:00.000Z" };
  assert.equal(hostFromCache(host(), cached).status, "online");
  assert.equal(hostFromCache(host(), cached).stale, true);
  assert.equal(hostFromCache(host(), cached, "starting").status, "starting");
  assert.equal(hostFromCache(host({ token: "" }), null).status, "needsLogin");
  assert.equal(hostFromCache(host(), null).status, "offline");
});

test("hosts order local first, then most recently used", () => {
  const ordered = orderHosts([
    host({ id: "b", lastUsedAt: "2026-09-02T00:00:00.000Z" }),
    host({ id: "local", kind: "local", lastUsedAt: "" }),
    host({ id: "a", lastUsedAt: "2026-09-03T00:00:00.000Z" }),
    host({ id: "t", kind: "tunnel", lastUsedAt: "2026-09-01T00:00:00.000Z" }),
  ]);
  assert.deepEqual(
    ordered.map((entry) => entry.id),
    ["local", "a", "b", "t"],
  );
});

function harness(overrides = {}) {
  const events = [];
  let cache = overrides.cache ?? {};
  const asked = [];
  const local = {
    state: "running",
    origin: "http://127.0.0.1:3210",
    firstRun: false,
    hasAccount: true,
    username: "kaleb",
    serverVersion: "1",
    error: "",
    lanOrigin: "",
    ...overrides.local,
  };
  const replies = overrides.replies ?? {};
  const feed = createHomeFeed({
    hosts: async () => overrides.hosts ?? [],
    localStatus: async () => local,
    fetchCampaigns: async (origin, token) => {
      asked.push(`${origin}|${token}`);
      const reply = replies[origin];
      return reply ?? { kind: "failed", error: `Could not reach ${origin}.` };
    },
    loadCache: async () => cache,
    saveCache: async (next) => {
      cache = next;
    },
    emit: (event) => events.push(event),
    now: () => "2026-09-04T10:00:00.000Z",
  });
  return { feed, events, asked, cache: () => cache, local };
}

test("a refresh asks every host with a token, caches, and announces the feed", async () => {
  const h = harness({
    hosts: [
      host({ id: "local", kind: "local", origin: "http://127.0.0.1:3210", token: "ltok" }),
      host({ id: "srv" }),
      host({ id: "dead", origin: "https://dead.example", token: "" }),
    ],
    replies: {
      "http://127.0.0.1:3210": { kind: "reply", status: 200, body: { campaigns: [rawCampaign] } },
      [origin]: { kind: "reply", status: 401, body: null },
    },
  });
  const feed = await h.feed.refresh();
  assert.equal(feed.refreshedAt, "2026-09-04T10:00:00.000Z");
  assert.deepEqual(
    feed.hosts.map((entry) => [entry.id, entry.status, entry.stale]),
    [
      ["local", "online", false],
      ["srv", "needsLogin", true],
      ["dead", "needsLogin", true],
    ],
  );
  // No token means no request at all.
  assert.deepEqual(h.asked.sort(), ["http://127.0.0.1:3210|ltok", `${origin}|tok`]);
  assert.equal(h.cache().local.campaigns.length, 1);
  assert.equal(h.cache().local.lastSeenAt, "2026-09-04T10:00:00.000Z");
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].kind, "home-feed");
  assert.deepEqual(h.events[0].feed, feed);
  // The cached view is now the last refresh.
  assert.deepEqual(await h.feed.cached(), feed);
});

test("a stopped local world is offline yet still lists its cached campaigns", async () => {
  const h = harness({
    hosts: [host({ id: "local", kind: "local", origin: "", token: "ltok" })],
    local: { state: "stopped", origin: "" },
    cache: {
      local: { status: "online", campaigns: [campaign()], lastSeenAt: "2026-09-03T00:00:00.000Z" },
    },
  });
  const before = await h.feed.cached();
  assert.equal(before.refreshedAt, "");
  assert.equal(before.hosts[0].status, "offline");
  assert.equal(before.hosts[0].campaigns.length, 1);
  const feed = await h.feed.refresh();
  assert.equal(feed.hosts[0].status, "offline");
  assert.equal(feed.hosts[0].stale, true);
  assert.deepEqual(feed.hosts[0].campaigns, [campaign()]);
  assert.deepEqual(h.asked, []);
  h.local.state = "starting";
  assert.equal((await h.feed.refresh()).hosts[0].status, "starting");
  h.local.state = "unavailable";
  assert.equal((await h.feed.refresh()).hosts[0].status, "unavailable");
});

test("a refresh requested mid-flight runs once more afterwards", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const events = [];
  let asked = 0;
  const feed = createHomeFeed({
    hosts: async () => [host()],
    localStatus: async () => ({ state: "stopped", origin: "", firstRun: false, hasAccount: false, username: "", serverVersion: "", error: "", lanOrigin: "" }),
    fetchCampaigns: async () => {
      asked += 1;
      if (asked === 1) await gate;
      return { kind: "reply", status: 200, body: { campaigns: [] } };
    },
    loadCache: async () => ({}),
    saveCache: async () => undefined,
    emit: (event) => events.push(event),
    now: () => "now",
  });
  const first = feed.refresh();
  const second = feed.refresh();
  assert.equal(first, second);
  release();
  await first;
  // Let the queued refresh run.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(asked, 2);
  assert.equal(events.length, 2);
});
