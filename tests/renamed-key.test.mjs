import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isUnsealHelper,
  parseUnsealReply,
  recoverRenamedSeals,
  UNSEAL_ARG,
  unsealWithRenamedKey,
} from "../dist/main/renamed-key.js";

// A store whose sealed values are a list, so a test reads what changed.
function fakeStore(unopened, tried = false) {
  const calls = { resealed: null, marked: false };
  return {
    calls,
    unopened: () => [...unopened],
    reseal: (opened) => {
      calls.resealed = Object.fromEntries(opened);
      return opened.size;
    },
    renamedKeyTried: () => tried,
    markRenamedKeyTried: () => {
      calls.marked = true;
    },
  };
}

test("nothing this run cannot open starts no helper", async () => {
  const store = fakeStore([]);
  let started = false;
  assert.equal(await recoverRenamedSeals(store, async () => (started = true, null)), 0);
  assert.equal(started, false);
  assert.equal(store.calls.marked, false);
});

test("what the helper opens is sealed again, and the job is done once", async () => {
  const store = fakeStore(["a", "b", "c"]);
  const count = await recoverRenamedSeals(store, async (ciphers) => {
    assert.deepEqual(ciphers, ["a", "b", "c"]);
    return { available: true, opened: ["pa", null, "pc"] };
  });
  assert.equal(count, 2);
  assert.deepEqual(store.calls.resealed, { a: "pa", c: "pc" });
  assert.equal(store.calls.marked, true);
});

// A Mac player who refused the keychain, or a helper that never answered,
// gets another try at the next start rather than losing the world.
test("a helper refused its key, or silent, is tried again next start", async () => {
  for (const reply of [{ available: false, opened: [null] }, null]) {
    const store = fakeStore(["a"]);
    assert.equal(await recoverRenamedSeals(store, async () => reply), 0);
    assert.equal(store.calls.resealed, null);
    assert.equal(store.calls.marked, false);
  }
});

test("an install that already looked starts no helper", async () => {
  const store = fakeStore(["a"], true);
  let started = false;
  await recoverRenamedSeals(store, async () => (started = true, null));
  assert.equal(started, false);
});

test("the helper's reply is read from its own line, and a short one is refused", () => {
  const out = 'some log\nunsealed:{"available":true,"opened":["x",null,3]}\n';
  assert.deepEqual(parseUnsealReply(out, 3), { available: true, opened: ["x", null, null] });
  assert.equal(parseUnsealReply(out, 2), null);
  assert.equal(parseUnsealReply("unsealed:{nope", 1), null);
  assert.equal(parseUnsealReply("", 0), null);
});

test("the helper is told apart by its flag and folder", () => {
  assert.equal(isUnsealHelper(["electron", `${UNSEAL_ARG}=/tmp/x`]), true);
  assert.equal(isUnsealHelper(["electron", UNSEAL_ARG]), false);
  assert.equal(isUnsealHelper(["electron", "."]), false);
});

// The shell starts the helper as it was itself started (here node and a
// stand-in script), hands it the ciphers in a folder of their own, reads its
// reply, and leaves no folder behind.
test("the helper is started with the ciphers and its reply comes back", async () => {
  const scripts = fs.mkdtempSync(path.join(os.tmpdir(), "odm-unseal-stub-"));
  const stub = path.join(scripts, "helper.cjs");
  fs.writeFileSync(
    stub,
    `const fs = require("fs"), path = require("path");
const dir = process.argv.find((a) => a.startsWith("${UNSEAL_ARG}=")).slice(${UNSEAL_ARG.length + 1});
const ciphers = JSON.parse(fs.readFileSync(path.join(dir, "ciphers.json"), "utf8"));
fs.writeFileSync(${JSON.stringify(path.join(scripts, "seen-dir"))}, dir);
process.stdout.write("noise\\nunsealed:" + JSON.stringify({ available: true, opened: ciphers.map((c) => c === "lost" ? null : "open:" + c) }) + "\\n");
`,
  );
  const reply = await unsealWithRenamedKey(["a", "lost"], { execPath: process.execPath, appPath: stub });
  assert.deepEqual(reply, { available: true, opened: ["open:a", null] });
  assert.equal(fs.existsSync(fs.readFileSync(path.join(scripts, "seen-dir"), "utf8")), false);
});

test("a helper that never answers gives up and gives nothing", async () => {
  const scripts = fs.mkdtempSync(path.join(os.tmpdir(), "odm-unseal-stub-"));
  const stub = path.join(scripts, "hang.cjs");
  fs.writeFileSync(stub, "setInterval(() => {}, 1000);\n");
  assert.equal(await unsealWithRenamedKey(["a"], { execPath: process.execPath, appPath: stub }, 300), null);
});
