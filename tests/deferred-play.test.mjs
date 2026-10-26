// play() while the shell is still fetching the element's new address (server
// issue 539): it waits for the address, then plays it; what the page does
// meanwhile wins, as it would in a browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeferredPlay } from "../dist/shared/deferred-play.js";

// A media element as far as play() goes: which address it holds, and which
// address each native play() started.
function fakeElement(src = "old.mp3") {
  const element = { src, started: [] };
  element.nativePlay = () => {
    element.started.push(element.src);
    return Promise.resolve();
  };
  return element;
}

function later() {
  let settle;
  const landed = new Promise((resolve) => (settle = resolve));
  return { landed, settle };
}

test("an element whose address is already set plays at once", async () => {
  const deferred = createDeferredPlay();
  const element = fakeElement();
  deferred.assigned(element);
  const played = deferred.play(element, element.nativePlay);
  assert.deepEqual(element.started, ["old.mp3"], "native play() is called in the same task");
  await played;
});

test("an element never handed an address by the shell is left alone", async () => {
  const deferred = createDeferredPlay();
  const element = fakeElement();
  await deferred.play(element, element.nativePlay);
  assert.deepEqual(element.started, ["old.mp3"]);
});

test("play() asked before the new address lands plays the new one, never the old", async () => {
  const deferred = createDeferredPlay();
  const element = fakeElement();
  const { landed, settle } = later();
  deferred.assigned(element, landed);
  const played = deferred.play(element, element.nativePlay);
  await Promise.resolve();
  assert.deepEqual(element.started, [], "nothing plays while the address is on its way");
  element.src = "blob:new";
  settle(true);
  await played;
  assert.deepEqual(element.started, ["blob:new"]);
});

test("once the address has landed, play() is immediate again", async () => {
  const deferred = createDeferredPlay();
  const element = fakeElement();
  const { landed, settle } = later();
  deferred.assigned(element, landed);
  element.src = "blob:new";
  settle(true);
  await landed;
  await Promise.resolve();
  deferred.play(element, element.nativePlay);
  assert.deepEqual(element.started, ["blob:new"]);
});

test("a newer address calls the waiting play() off with an AbortError and the newer play() goes ahead", async () => {
  const deferred = createDeferredPlay();
  const element = fakeElement();
  const first = later();
  deferred.assigned(element, first.landed);
  const overtaken = deferred.play(element, element.nativePlay);
  const second = later();
  deferred.assigned(element, second.landed);
  const current = deferred.play(element, element.nativePlay);
  first.settle(false);
  await assert.rejects(overtaken, (error) => error instanceof DOMException && error.name === "AbortError");
  element.src = "blob:second";
  second.settle(true);
  await current;
  assert.deepEqual(element.started, ["blob:second"], "only the address the page set last is played");
});

test("an address the page sets directly also calls a waiting play() off", async () => {
  const deferred = createDeferredPlay();
  const element = fakeElement();
  const { landed, settle } = later();
  deferred.assigned(element, landed);
  const overtaken = deferred.play(element, element.nativePlay);
  deferred.assigned(element);
  settle(true);
  await assert.rejects(overtaken, (error) => error.name === "AbortError");
  assert.deepEqual(element.started, []);
});

test("pause() while the address is on its way keeps the element quiet", async () => {
  const deferred = createDeferredPlay();
  const element = fakeElement();
  const { landed, settle } = later();
  deferred.assigned(element, landed);
  const paused = deferred.play(element, element.nativePlay);
  deferred.paused(element);
  settle(true);
  await assert.rejects(paused, (error) => error.name === "AbortError");
  assert.deepEqual(element.started, [], "a paused element does not start once its file arrives");
});

test("play() after a pause, still before the address lands, plays it", async () => {
  const deferred = createDeferredPlay();
  const element = fakeElement();
  const { landed, settle } = later();
  deferred.assigned(element, landed);
  const first = deferred.play(element, element.nativePlay);
  deferred.paused(element);
  const second = deferred.play(element, element.nativePlay);
  element.src = "blob:new";
  settle(true);
  await assert.rejects(first, (error) => error.name === "AbortError");
  await second;
  assert.deepEqual(element.started, ["blob:new"]);
});

test("an address the host refused rejects play() as a file that will not load", async () => {
  const deferred = createDeferredPlay();
  const element = fakeElement();
  const { landed, settle } = later();
  deferred.assigned(element, landed);
  const played = deferred.play(element, element.nativePlay);
  settle(false);
  await assert.rejects(played, (error) => error instanceof DOMException && error.name === "NotSupportedError");
  assert.deepEqual(element.started, [], "the old file is not played in its place");
});

test("a native play() that is refused reaches the page unchanged", async () => {
  const deferred = createDeferredPlay();
  const element = fakeElement();
  const { landed, settle } = later();
  deferred.assigned(element, landed);
  const refusal = new DOMException("gesture first", "NotAllowedError");
  const played = deferred.play(element, () => Promise.reject(refusal));
  settle(true);
  await assert.rejects(played, (error) => error === refusal);
});
