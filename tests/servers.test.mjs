import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LOCAL_SERVER_ID, ServerStore } from "../dist/main/servers.js";

const crypt = {
  encrypt: (plain) => `enc:${plain}`,
  decrypt: (cipher) => (cipher.startsWith("enc:") ? cipher.slice(4) : null),
};

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-store-"));
  return { store: new ServerStore(path.join(dir, "servers.json"), crypt), dir };
}

const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 1000).toISOString();

test("the local profile secret is stored encrypted and survives token refreshes", () => {
  const { store } = freshStore();
  store.upsert({
    id: LOCAL_SERVER_ID,
    origin: "local",
    name: "This computer",
    username: "kaleb",
    token: "tok1",
    tokenExpiresAt: future,
    secret: "profile-password",
  });
  assert.equal(store.secret(LOCAL_SERVER_ID), "profile-password");
  // A token refresh without a secret must not drop the stored password.
  store.upsert({
    id: LOCAL_SERVER_ID,
    origin: "local",
    name: "This computer",
    username: "kaleb",
    token: "tok2",
    tokenExpiresAt: future,
  });
  assert.equal(store.secret(LOCAL_SERVER_ID), "profile-password");
  assert.equal(store.token(LOCAL_SERVER_ID), "tok2");
  // Servers without a stored secret report null, not a decryption error.
  const remote = store.upsert({
    origin: "https://r.example",
    name: "R",
    username: "kaleb",
    token: "tok",
    tokenExpiresAt: future,
  });
  assert.equal(store.secret(remote.id), null);
});

test("upsert dedupes remote servers by origin and keeps the id", () => {
  const { store } = freshStore();
  const first = store.upsert({
    origin: "https://a.example",
    name: "A",
    username: "kaleb",
    token: "tok1",
    tokenExpiresAt: future,
  });
  const second = store.upsert({
    origin: "https://a.example",
    name: "A renamed",
    username: "kaleb",
    token: "tok2",
    tokenExpiresAt: future,
  });
  assert.equal(first.id, second.id);
  assert.equal(store.list().length, 1);
  assert.equal(store.token(first.id), "tok2");
});

test("upsert falls back to the instanceId so a moved world keeps one entry", () => {
  const { store } = freshStore();
  const first = store.upsert({
    origin: "https://play-OLDCODE.example",
    name: "Dave's world",
    username: "kaleb",
    token: "tok1",
    tokenExpiresAt: future,
    instanceId: "world-1",
  });
  // Same world, new tunnel hostname: refreshed in place, not duplicated.
  const second = store.upsert({
    origin: "https://play-NEWCODE.example",
    name: "Dave's world",
    username: "kaleb",
    token: "tok2",
    tokenExpiresAt: future,
    instanceId: "world-1",
  });
  assert.equal(first.id, second.id);
  assert.equal(store.list().length, 1);
  assert.equal(store.get(first.id).origin, "https://play-NEWCODE.example");
  // A blank instanceId never matches anything.
  store.upsert({
    origin: "https://old-server-a.example",
    name: "A",
    username: "kaleb",
    token: "tok",
    tokenExpiresAt: future,
    instanceId: "",
  });
  store.upsert({
    origin: "https://old-server-b.example",
    name: "B",
    username: "kaleb",
    token: "tok",
    tokenExpiresAt: future,
  });
  assert.equal(store.list().length, 3);
});

test("findByInstanceId, rebindOrigin and setInstanceId move a world, not copy it", () => {
  const { store } = freshStore();
  const entry = store.upsert({
    origin: "https://play-OLDCODE.example",
    name: "Dave's world",
    username: "kaleb",
    token: "tok",
    tokenExpiresAt: future,
  });
  // Entries saved before the server exposed an instanceId get it backfilled.
  assert.equal(store.findByInstanceId("world-1"), null);
  store.setInstanceId(entry.id, "world-1");
  assert.equal(store.findByInstanceId("world-1")?.id, entry.id);
  assert.equal(store.findByInstanceId(""), null);

  const moved = store.rebindOrigin(entry.id, "https://play-NEWCODE.example");
  assert.equal(moved.id, entry.id);
  assert.equal(store.get(entry.id).origin, "https://play-NEWCODE.example");
  assert.equal(store.token(entry.id), "tok");
  assert.equal(store.list().length, 1);
  assert.equal(store.rebindOrigin("missing", "https://x.example"), null);
});

test("expired or missing tokens read as null and summaries reflect it", () => {
  const { store } = freshStore();
  const live = store.upsert({
    origin: "https://live.example",
    name: "Live",
    username: "kaleb",
    token: "tok",
    tokenExpiresAt: future,
  });
  const dead = store.upsert({
    origin: "https://dead.example",
    name: "Dead",
    username: "kaleb",
    token: "tok",
    tokenExpiresAt: past,
  });
  assert.equal(store.token(live.id), "tok");
  assert.equal(store.token(dead.id), null);
  const byOrigin = new Map(store.summaries().map((entry) => [entry.origin, entry.hasToken]));
  assert.equal(byOrigin.get("https://live.example"), true);
  assert.equal(byOrigin.get("https://dead.example"), false);
});

test("the local entry is addressed by id and hidden from the remote list", () => {
  const { store } = freshStore();
  store.upsert({
    id: LOCAL_SERVER_ID,
    origin: "local",
    name: "This computer",
    username: "kaleb",
    token: "local-tok",
    tokenExpiresAt: future,
  });
  store.upsert({
    id: LOCAL_SERVER_ID,
    origin: "local",
    name: "This computer",
    username: "kaleb",
    token: "local-tok-2",
    tokenExpiresAt: future,
  });
  assert.equal(store.list().length, 0);
  assert.equal(store.summaries().length, 0);
  assert.equal(store.token(LOCAL_SERVER_ID), "local-tok-2");
});

test("registry persists across instances and survives corruption", () => {
  const { store, dir } = freshStore();
  const entry = store.upsert({
    origin: "https://a.example",
    name: "A",
    username: "kaleb",
    token: "tok",
    tokenExpiresAt: future,
  });
  const reopened = new ServerStore(path.join(dir, "servers.json"), crypt);
  assert.equal(reopened.token(entry.id), "tok");

  fs.writeFileSync(path.join(dir, "servers.json"), "{not json");
  const corrupted = new ServerStore(path.join(dir, "servers.json"), crypt);
  assert.deepEqual(corrupted.list(), []);
});

test("the home cache is kept beside the servers and replaced whole", () => {
  const { store, dir } = freshStore();
  assert.deepEqual(store.homeCache(), {});
  const entry = { status: "online", campaigns: [], lastSeenAt: "2026-09-04T00:00:00.000Z" };
  store.saveHomeCache({ local: entry, gone: entry });
  assert.deepEqual(new ServerStore(path.join(dir, "servers.json"), crypt).homeCache(), {
    local: entry,
    gone: entry,
  });
  store.saveHomeCache({ local: entry });
  assert.deepEqual(Object.keys(store.homeCache()), ["local"]);
});

test("remove forgets the server", () => {
  const { store } = freshStore();
  const entry = store.upsert({
    origin: "https://a.example",
    name: "A",
    username: "kaleb",
    token: "tok",
    tokenExpiresAt: future,
  });
  store.remove(entry.id);
  assert.equal(store.get(entry.id), null);
  assert.equal(store.list().length, 0);
});
