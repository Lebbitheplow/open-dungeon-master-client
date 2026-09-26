// Story memory: the device world's embedding model choice, what it hands the
// bundled server, where it can run, and that the choice survives a restart
// of the app.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ServerStore } from "../dist/main/servers.js";
import { DESKTOP_TARGETS } from "../scripts/stage-desktop-payload.mjs";
import {
  parseStoryMemory,
  storyMemoryEnv,
  storyMemorySupported,
} from "../dist/shared/story-memory.js";

const crypt = { encrypt: (plain) => plain, decrypt: (cipher) => cipher };

test("English hands the server nothing, so its own default model runs", () => {
  assert.deepEqual(storyMemoryEnv("english"), { EMBEDDING_MODEL: "", EMBEDDING_DTYPE: "" });
});

test("many languages hands the server the multilingual model at q8", () => {
  assert.deepEqual(storyMemoryEnv("multilingual"), {
    EMBEDDING_MODEL: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    EMBEDDING_DTYPE: "q8",
  });
});

test("anything unrecognised reads as the English default", () => {
  assert.equal(parseStoryMemory("multilingual"), "multilingual");
  for (const raw of ["english", "", undefined, null, 3, "MULTILINGUAL", { id: "multilingual" }]) {
    assert.equal(parseStoryMemory(raw), "english");
  }
});

test("the setting exists exactly where a package carries the embedding runtime", () => {
  assert.equal(storyMemorySupported("linux", "x64"), true);
  assert.equal(storyMemorySupported("win32", "x64"), true);
  assert.equal(storyMemorySupported("darwin", "arm64"), true);
  // onnxruntime ships no Intel Mac build; the phone payload has no runtime.
  assert.equal(storyMemorySupported("darwin", "x64"), false);
  assert.equal(storyMemorySupported("android", "arm64"), false);
  // Every packaged target but the Intel Mac gets a binding from the bundler.
  const withRuntime = DESKTOP_TARGETS.filter((target) => target !== "darwin/x64");
  for (const target of withRuntime) {
    const [platform, arch] = target.split("/");
    assert.equal(storyMemorySupported(platform, arch), true, target);
  }
});

test("the choice is kept across app starts, and English leaves no trace", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-memory-"));
  const file = path.join(dir, "servers.json");
  try {
    const store = new ServerStore(file, crypt);
    assert.equal(store.storyMemory(), "english");
    store.setStoryMemory("multilingual");
    assert.equal(new ServerStore(file, crypt).storyMemory(), "multilingual");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).storyMemory, "multilingual");
    store.setStoryMemory("english");
    assert.equal(new ServerStore(file, crypt).storyMemory(), "english");
    assert.equal("storyMemory" in JSON.parse(fs.readFileSync(file, "utf8")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
