import assert from "node:assert/strict";
import { test } from "node:test";
import { createShortCache, createTransitionDebounce } from "../src/throttle";

// The home feed's refresh trigger and the short status cache.

function fakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    pending,
    setTimer: (fn: () => void) => {
      const id = next++;
      pending.set(id, fn);
      return id;
    },
    clearTimer: (handle: unknown) => {
      pending.delete(handle as number);
    },
    fire() {
      for (const [id, fn] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
  };
}

test("a burst of transitions becomes one trailing refresh; repeats and 'starting' do not count", () => {
  const timers = fakeTimers();
  let fired = 0;
  const debounce = createTransitionDebounce({
    delayMs: 1500,
    fire: () => {
      fired += 1;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  assert.equal(debounce.notice("local-status", "starting"), false);
  assert.equal(debounce.notice("local-status", "running"), true);
  assert.equal(debounce.notice("local-status", "running"), false, "the same state again is no news");
  assert.equal(debounce.notice("tunnel-status", "running"), true);
  assert.equal(timers.pending.size, 1, "one timer at a time");
  assert.equal(fired, 0);
  timers.fire();
  assert.equal(fired, 1);
  // A world restarting quickly ends where it was: no refresh.
  assert.equal(debounce.notice("local-status", "starting"), false);
  assert.equal(debounce.notice("local-status", "running"), false);
  assert.equal(timers.pending.size, 0);
  // Going down is news, so is coming back.
  assert.equal(debounce.notice("local-status", "stopped"), true);
  assert.equal(debounce.notice("local-status", "error"), true);
  timers.fire();
  assert.equal(fired, 2);
  assert.equal(debounce.notice("local-status", "running"), true);
});

test("the short cache folds calls within its window into one and forgets failures", async () => {
  let clock = 0;
  let loads = 0;
  let fail = false;
  const cache = createShortCache(
    1500,
    async () => {
      loads += 1;
      if (fail) throw new Error("no");
      return loads;
    },
    () => clock,
  );
  assert.equal(await cache.get(), 1);
  clock = 1000;
  assert.equal(await cache.get(), 1);
  clock = 1600;
  assert.equal(await cache.get(), 2);
  cache.clear();
  assert.equal(await cache.get(), 3);
  clock = 1700;
  fail = true;
  cache.clear();
  await assert.rejects(cache.get());
  fail = false;
  assert.equal(await cache.get(), 5, "a failed load is not served again");
});
