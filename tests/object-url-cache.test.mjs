import assert from "node:assert/strict";
import test from "node:test";
import { createObjectUrlCache, createRevokePool } from "../dist/shared/object-url-cache.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// docs/vtt-parity-implementation-plan.md 18.3: a protected path is fetched
// once per session, the oldest URLs are revoked as the ring fills, and a
// failed fetch is not pinned.
test("a path is loaded once and the oldest is revoked past the cap", async () => {
  const revoked = [];
  const cache = createObjectUrlCache({ maxEntries: 2, retire: (url) => revoked.push(url) });
  let loads = 0;
  const load = (name) => async () => {
    loads += 1;
    return `blob:${name}`;
  };
  assert.equal(await cache.get("a", load("a")), "blob:a");
  assert.equal(await cache.get("a", load("a")), "blob:a");
  assert.equal(loads, 1, "the second ask did not fetch again");
  await cache.get("b", load("b"));
  await cache.get("c", load("c"));
  await tick();
  assert.deepEqual(revoked, ["blob:a"]);
  assert.equal(cache.size(), 2);
});

test("touching a path keeps it, and a failed fetch is retried next time", async () => {
  const revoked = [];
  const cache = createObjectUrlCache({ maxEntries: 2, retire: (url) => revoked.push(url) });
  await cache.get("a", async () => "blob:a");
  await cache.get("b", async () => "blob:b");
  await cache.get("a", async () => "blob:a-again");
  await cache.get("c", async () => "blob:c");
  await tick();
  assert.deepEqual(revoked, ["blob:b"], "the recently used one stayed");
  let tries = 0;
  const failing = async () => {
    tries += 1;
    throw new Error("offline");
  };
  assert.equal(await cache.get("d", failing), "");
  assert.equal(await cache.get("d", failing), "");
  assert.equal(tries, 2, "an empty answer was not pinned");
  cache.clear();
  await tick();
  assert.equal(cache.size(), 0);
  assert.deepEqual(revoked, ["blob:b", "blob:a", "blob:c"], "clear retired the rest in age order");
});

// The ring is also bounded by bytes: big pictures push older ones out well
// before the entry cap, while a single picture over the cap still stays.
test("the byte cap retires the oldest entries once their sizes are known", async () => {
  const revoked = [];
  const cache = createObjectUrlCache({ maxEntries: 10, maxBytes: 100, retire: (url) => revoked.push(url) });
  const load = (name, bytes) => async () => ({ url: `blob:${name}`, bytes });
  await cache.get("a", load("a", 40));
  await cache.get("b", load("b", 40));
  assert.equal(cache.bytes(), 80);
  await cache.get("c", load("c", 40));
  await tick();
  assert.deepEqual(revoked, ["blob:a"]);
  assert.equal(cache.bytes(), 80);
  await cache.get("huge", load("huge", 500));
  await tick();
  assert.deepEqual(revoked, ["blob:a", "blob:b", "blob:c"]);
  assert.equal(cache.size(), 1, "the one over the cap is kept rather than the ring emptied");
  assert.equal(await cache.get("huge", load("huge", 500)), "blob:huge");
});

// An evicted URL that something still shows is not revoked yet: it waits
// in the pool and is revoked on a later sweep, once nothing shows it.
test("an evicted URL still in use waits for a sweep", async () => {
  const shown = new Set(["blob:a"]);
  const revoked = [];
  const pool = createRevokePool({ inUse: (url) => shown.has(url), revoke: (url) => revoked.push(url), sweepMs: 60_000 });
  const cache = createObjectUrlCache({ maxEntries: 1, retire: pool.retire });
  await cache.get("a", async () => "blob:a");
  await cache.get("b", async () => "blob:b");
  await tick();
  assert.deepEqual(revoked, [], "the shown picture was not revoked");
  assert.equal(pool.pending(), 1);
  // A later retirement sweeps the pending set first.
  await cache.get("c", async () => "blob:c");
  await tick();
  assert.deepEqual(revoked, ["blob:b"], "the unshown one went at once, the shown one still waits");
  assert.equal(pool.pending(), 1);
  shown.delete("blob:a");
  assert.equal(pool.sweep(), 0);
  assert.deepEqual(revoked, ["blob:b", "blob:a"]);
  pool.dispose();
});
