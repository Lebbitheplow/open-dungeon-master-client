import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDesktopHomeFeed } from "../dist/main/home-feed.js";
import { LOCAL_SERVER_ID, ServerStore } from "../dist/main/servers.js";

// The desktop wiring: hosts come out of the servers registry with their
// decrypted tokens, the cache lives in the same file, and the local world's
// status decides whether the local host is asked at all.

const crypt = {
  encrypt: (plain) => `enc:${plain}`,
  decrypt: (cipher) => (cipher.startsWith("enc:") ? cipher.slice(4) : null),
};
const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 1000).toISOString();

function localStatus(state) {
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

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-home-"));
  const file = path.join(dir, "servers.json");
  const store = new ServerStore(file, crypt);
  store.upsert({
    id: LOCAL_SERVER_ID,
    origin: "local",
    name: "This computer",
    username: "kaleb",
    token: "local-tok",
    tokenExpiresAt: future,
  });
  const remote = store.upsert({
    origin: "https://dungeon.example",
    name: "Dungeon",
    username: "kaleb",
    token: "remote-tok",
    tokenExpiresAt: future,
  });
  const tunnel = store.upsert({
    origin: "https://play-abcd1234.opendungeonmaster.com",
    name: "Sam's world",
    username: "kaleb",
    token: "tunnel-tok",
    tokenExpiresAt: past,
  });
  const asked = [];
  const events = [];
  let local = localStatus("running");
  const feed = createDesktopHomeFeed({
    store,
    localStatus: () => local,
    emit: (event) => events.push(event),
    fetchCampaigns: async (origin, token) => {
      asked.push(`${origin}|${token}`);
      if (origin === "http://127.0.0.1:3210") {
        return {
          kind: "reply",
          status: 200,
          body: { campaigns: [{ id: "c1", title: "Home game", status: "active", role: "owner" }] },
        };
      }
      return { kind: "failed", error: `Could not reach ${origin}.` };
    },
    now: () => "2026-09-04T10:00:00.000Z",
  });
  return {
    feed,
    store,
    file,
    asked,
    events,
    remote,
    tunnel,
    setLocal: (state) => {
      local = localStatus(state);
    },
  };
}

test("hosts come from the registry with kinds and tokens, and the cache persists", async () => {
  const h = harness();
  const feed = await h.feed.refresh();
  // The two remote entries were saved within the same millisecond, so only
  // the local-first rule is asserted on order; the rest by id.
  assert.equal(feed.hosts[0].id, LOCAL_SERVER_ID);
  assert.deepEqual(
    Object.fromEntries(feed.hosts.map((host) => [host.id, [host.kind, host.status]])),
    {
      [LOCAL_SERVER_ID]: ["local", "online"],
      [h.tunnel.id]: ["tunnel", "needsLogin"],
      [h.remote.id]: ["server", "offline"],
    },
  );
  assert.equal(feed.hosts[0].name, "This computer");
  assert.equal(feed.hosts[0].campaigns[0].coverUrl, null);
  // The expired tunnel token was never sent.
  assert.deepEqual(h.asked.sort(), [
    "http://127.0.0.1:3210|local-tok",
    "https://dungeon.example|remote-tok",
  ]);
  assert.equal(h.events.at(-1).kind, "home-feed");
  const onDisk = JSON.parse(fs.readFileSync(h.file, "utf8"));
  assert.equal(onDisk.homeCache[LOCAL_SERVER_ID].campaigns[0].title, "Home game");
  assert.equal(onDisk.homeCache[LOCAL_SERVER_ID].lastSeenAt, "2026-09-04T10:00:00.000Z");
});

test("a stopped local world keeps its cached campaigns and is not asked", async () => {
  const h = harness();
  await h.feed.refresh();
  h.asked.length = 0;
  h.setLocal("stopped");
  const feed = await h.feed.refresh();
  assert.equal(feed.hosts[0].status, "offline");
  assert.equal(feed.hosts[0].stale, true);
  assert.equal(feed.hosts[0].campaigns[0].title, "Home game");
  assert.equal(h.asked.some((line) => line.startsWith("http://127.0.0.1")), false);
});

test("a fresh instance serves the persisted cache before any refresh", async () => {
  const h = harness();
  await h.feed.refresh();
  const again = createDesktopHomeFeed({
    store: new ServerStore(h.file, crypt),
    localStatus: () => localStatus("stopped"),
    emit: () => undefined,
    fetchCampaigns: async () => ({ kind: "failed", error: "no" }),
  });
  const cached = await again.cached();
  assert.equal(cached.refreshedAt, "");
  assert.equal(cached.hosts[0].status, "offline");
  assert.equal(cached.hosts[0].campaigns[0].title, "Home game");
  assert.equal(cached.hosts[0].stale, true);
});

test("removing a server drops its cache entry", async () => {
  const h = harness();
  await h.feed.refresh();
  assert.ok(h.store.homeCache()[h.remote.id]);
  h.store.remove(h.remote.id);
  assert.equal(h.store.homeCache()[h.remote.id], undefined);
});
