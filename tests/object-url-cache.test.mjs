import assert from "node:assert/strict";
import test from "node:test";
import { createObjectUrlCache } from "../dist/shared/object-url-cache.js";

// docs/vtt-parity-implementation-plan.md 18.3: a protected path is fetched
// once per session, the oldest URLs are revoked as the ring fills, and a
// failed fetch is not pinned.
test("a path is loaded once and the oldest is revoked past the cap", async () => {
  const revoked = [];
  const cache = createObjectUrlCache(2, (url) => revoked.push(url));
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
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(revoked, ["blob:a"]);
  assert.equal(cache.size(), 2);
});

test("touching a path keeps it, and a failed fetch is retried next time", async () => {
  const revoked = [];
  const cache = createObjectUrlCache(2, (url) => revoked.push(url));
  await cache.get("a", async () => "blob:a");
  await cache.get("b", async () => "blob:b");
  await cache.get("a", async () => "blob:a-again");
  await cache.get("c", async () => "blob:c");
  await new Promise((resolve) => setTimeout(resolve, 0));
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
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cache.size(), 0);
});
