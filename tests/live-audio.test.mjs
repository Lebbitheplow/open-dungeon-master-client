// Narration read as it arrives (server issue 97): which addresses are live,
// and that a stream is handed on piece by piece, in order, one at a time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isLiveNarrationPath, pump } from "../dist/shared/live-audio.js";

test("only a narration address marked live is read as it arrives", () => {
  assert.equal(isLiveNarrationPath("/generated-audio/camp/msg.mp3?v=17&live=1"), true);
  assert.equal(isLiveNarrationPath("/generated-audio/camp/msg.mp3?live=1"), true);
  assert.equal(isLiveNarrationPath("/generated-audio/camp/msg.mp3?v=17"), false, "a finished take is fetched whole and kept");
  assert.equal(isLiveNarrationPath("/generated-audio/camp/msg.mp3"), false);
  assert.equal(isLiveNarrationPath("/ambience/rain.ogg?live=1"), false, "nothing else is narration");
  assert.equal(isLiveNarrationPath("/generated-audio/camp/msg.mp3?alive=1"), false);
});

test("a stream is appended in order, never two pieces at once", async () => {
  const pieces = [new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3]), new Uint8Array([4, 5, 6])];
  const body = new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(piece);
      controller.close();
    },
  });
  const seen = [];
  let busy = false;
  const bytes = await pump(body, async (chunk) => {
    assert.equal(busy, false, "the buffer is only given a piece when it is ready");
    busy = true;
    await new Promise((resolve) => setTimeout(resolve, 2));
    seen.push(...chunk);
    busy = false;
  });
  assert.equal(bytes, 6);
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6]);
});

test("a buffer that refuses a piece stops the stream", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.enqueue(new Uint8Array([2]));
      controller.close();
    },
  });
  await assert.rejects(
    pump(body, async () => {
      throw new Error("full");
    }),
    /full/,
  );
});
