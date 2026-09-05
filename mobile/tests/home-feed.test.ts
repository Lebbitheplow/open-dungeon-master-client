import assert from "node:assert/strict";
import { test } from "node:test";
import type { LocalStatus, ShellEvent } from "../../src/shared/types";
import { createAndroidHomeFeed, HOME_CACHE_KEY, type AndroidHomeFeedDeps } from "../src/home-feed";

// The Android wiring of the home feed against fake Preferences and HTTP.

function localStatus(state: LocalStatus["state"]): LocalStatus {
  return {
    state,
    origin: state === "running" ? "http://127.0.0.1:3210" : "",
    firstRun: false,
    hasAccount: true,
    username: "kaleb",
    serverVersion: "1",
    error: "",
    lanOrigin: "",
  };
}

function harness(overrides: { local?: LocalStatus["state"]; localToken?: string } = {}) {
  const prefs = new Map<string, string>();
  const asked: string[] = [];
  const events: ShellEvent[] = [];
  const deps: AndroidHomeFeedDeps = {
    servers: async () => [
      {
        id: "srv",
        origin: "https://dungeon.example",
        name: "Dungeon",
        username: "kaleb",
        lastUsedAt: "2026-09-01T00:00:00.000Z",
        token: "remote-tok",
      },
      {
        id: "tun",
        origin: "https://quiet-owl-42.trycloudflare.com",
        name: "Sam's phone",
        username: "kaleb",
        lastUsedAt: "2026-09-02T00:00:00.000Z",
        token: "",
      },
    ],
    localStatus: async () => localStatus(overrides.local ?? "running"),
    localToken: async () => overrides.localToken ?? "local-tok",
    fetchJson: async (url, init) => {
      asked.push(`${url}|${init?.headers?.authorization ?? ""}|${init?.timeoutMs ?? ""}`);
      if (url.startsWith("http://127.0.0.1")) {
        return {
          status: 200,
          data: { campaigns: [{ id: "c1", title: "Phone game", status: "lobby", role: "owner" }] },
        };
      }
      return { status: 403, data: { error: "Forbidden" } };
    },
    getPref: async (key) => prefs.get(key) ?? null,
    setPref: async (key, value) => {
      prefs.set(key, value);
    },
    emit: (event) => events.push(event),
    now: () => "2026-09-04T10:00:00.000Z",
  };
  return { feed: createAndroidHomeFeed(deps), prefs, asked, events };
}

test("the device world leads, servers follow by last use, tunnels are recognized", async () => {
  const h = harness();
  const feed = await h.feed.refresh();
  assert.deepEqual(
    feed.hosts.map((host) => [host.id, host.kind, host.status, host.stale]),
    [
      ["local", "local", "online", false],
      ["tun", "tunnel", "needsLogin", true],
      ["srv", "server", "needsLogin", true],
    ],
  );
  assert.equal(feed.hosts[0]?.name, "This device");
  assert.equal(feed.hosts[0]?.campaigns[0]?.title, "Phone game");
  // Bearer auth with the 6 s cap; the dead tunnel token was never sent.
  assert.deepEqual(h.asked.sort(), [
    "http://127.0.0.1:3210/api/campaigns|Bearer local-tok|6000",
    "https://dungeon.example/api/campaigns|Bearer remote-tok|6000",
  ]);
  assert.equal(h.events.at(-1)?.kind, "home-feed");
});

test("the cache round-trips through Preferences and serves a stopped world", async () => {
  const warm = harness();
  await warm.feed.refresh();
  const stored = warm.prefs.get(HOME_CACHE_KEY);
  assert.ok(stored);
  const cold = harness({ local: "stopped" });
  cold.prefs.set(HOME_CACHE_KEY, stored as string);
  const cached = await cold.feed.cached();
  assert.equal(cached.refreshedAt, "");
  assert.equal(cached.hosts[0]?.status, "offline");
  assert.equal(cached.hosts[0]?.campaigns[0]?.title, "Phone game");
  const refreshed = await cold.feed.refresh();
  assert.equal(refreshed.hosts[0]?.status, "offline");
  assert.equal(refreshed.hosts[0]?.stale, true);
  assert.equal(refreshed.hosts[0]?.campaigns.length, 1);
  assert.equal(cold.asked.some((line) => line.startsWith("http://127.0.0.1")), false);
});

test("a corrupt cache reads as empty rather than failing the feed", async () => {
  const h = harness({ localToken: "" });
  h.prefs.set(HOME_CACHE_KEY, "{not json");
  const feed = await h.feed.refresh();
  assert.equal(feed.hosts[0]?.status, "needsLogin");
  assert.deepEqual(feed.hosts[0]?.campaigns, []);
});
