import assert from "node:assert/strict";
import test from "node:test";
import { speechStatusFrom, speechSummary } from "../dist/shared/speech.js";

// The device world's Admin > Speech answer, as the Local AI screen reads it.

test("a fresh world reads as not installed, nobody listening", () => {
  const status = speechStatusFrom({
    builtin: { installed: false, status: "idle", progress: 0, error: "", downloadMb: 76 },
    active: "none",
  });
  assert.deepEqual(status, { installed: false, status: "idle", progress: 0, error: "", downloadMb: 76, active: "none" });
  assert.match(speechSummary(status), /Not installed.*76 MB/);
});

test("a download in flight shows its percentage", () => {
  const status = speechStatusFrom({ builtin: { status: "installing", progress: 0.426 }, active: "none" });
  assert.equal(speechSummary(status), "Downloading Whisper: 43%.");
});

test("installed, a Whisper service, OpenAI and a failure each say what they are", () => {
  assert.match(speechSummary(speechStatusFrom({ builtin: { installed: true, status: "ready" }, active: "builtin" })), /^Installed/);
  assert.match(speechSummary(speechStatusFrom({ active: "whisper" })), /Whisper service/);
  assert.match(speechSummary(speechStatusFrom({ active: "openai" })), /OpenAI on your key/);
  assert.match(
    speechSummary(speechStatusFrom({ builtin: { status: "error", error: "no network" } })),
    /The download failed: no network/,
  );
});

test("odd answers are read safely", () => {
  const status = speechStatusFrom({ builtin: { status: "exploded", progress: 7, downloadMb: -1 }, active: "martian" });
  assert.equal(status.status, "idle");
  assert.equal(status.progress, 1);
  assert.equal(status.downloadMb, 76);
  assert.equal(status.active, "none");
  assert.deepEqual(speechStatusFrom(null).active, "none");
});
