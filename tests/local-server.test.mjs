// The desktop's device world (src/main/local-server.ts) around a stand-in
// server: a start unpacks the payload and the world answers; a tree that
// lost a file since is rebuilt once, on its own, when the start fails and
// the payload's manifest finds the damage, with the installed world packs
// carried across; a start that fails for any other reason is reported as it
// is, the tree left alone; and the repair Settings asks for by hand puts a
// torn file back, keeps the player's folders, and wakes the world again
// only when it was awake. The stand-in is a Node script answering
// /api/health, started the way the real server is (process.execPath in Node
// mode, which is node itself under the test runner).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalServer } from "../dist/main/local-server.js";
import { writePayloadManifest } from "../dist/main/payload-manifest.js";
import { MARKER } from "../dist/main/payload-store.js";

const SERVER = `
const http = require("node:http");
if (process.env.ODM_TEST_EXIT) process.exit(Number(process.env.ODM_TEST_EXIT));
http
  .createServer((req, res) => {
    res.statusCode = req.url === "/api/health" ? 200 : 404;
    res.end("ok");
  })
  .listen(Number(process.env.PORT), process.env.HOSTNAME);
`;
const HELPER = "module.exports = 1;\n";

async function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-local-server-"));
  const payload = path.join(dir, "payload");
  fs.mkdirSync(payload, { recursive: true });
  fs.writeFileSync(path.join(payload, "server.js"), SERVER);
  fs.writeFileSync(path.join(payload, "helper.js"), HELPER);
  fs.writeFileSync(path.join(payload, MARKER), JSON.stringify({ serverVersion: "1.0.0", builtAt: "2026-10-12T00:00:00.000Z" }));
  await writePayloadManifest(payload);
  const userData = path.join(dir, "user-data");
  const run = path.join(userData, "local-server");
  const local = new LocalServer(payload, userData, path.join(dir, "renderer"));
  return {
    dir,
    payload,
    userData,
    run,
    local,
    cleanup: async () => {
      await local.stop().catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const read = (file) => fs.readFileSync(file, "utf8");

test("a start unpacks the payload and the world answers; stopped, it is asleep", async () => {
  const w = await world();
  try {
    await w.local.start();
    assert.equal(w.local.running, true);
    assert.match(w.local.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(read(path.join(w.run, "server.js")), SERVER);
    assert.deepEqual(await w.local.verify(true), { unpacked: true, listed: 2, missing: [], changed: [], hashed: true });
    const facts = w.local.diagnostics();
    assert.equal(facts.payload.builtAt, facts.runTree.builtAt);
    assert.equal(facts.keyPresent, true, "the database key is minted at the first start");
    assert.deepEqual(facts.packs, []);
    await w.local.stop();
    assert.equal(w.local.running, false);
    assert.equal(w.local.status(false).state, "stopped");
  } finally {
    await w.cleanup();
  }
});

test("a tree that lost its server since is rebuilt once and the world starts after all, packs and all", async () => {
  const w = await world();
  try {
    await w.local.start();
    await w.local.stop();
    fs.rmSync(path.join(w.run, "server.js"));
    fs.mkdirSync(path.join(w.run, "data", "worlds"), { recursive: true });
    fs.writeFileSync(path.join(w.run, "data", "worlds", "hollow_marsh.json"), "{}");
    await w.local.start();
    assert.equal(w.local.running, true);
    assert.equal(read(path.join(w.run, "server.js")), SERVER, "the server file is back");
    assert.equal(read(path.join(w.run, "data", "worlds", "hollow_marsh.json")), "{}", "the installed pack rode across the rebuild");
    assert.deepEqual(w.local.diagnostics().packs, ["hollow_marsh"]);
    assert.equal(w.local.status(false).state, "running");
  } finally {
    await w.cleanup();
  }
});

test("a start that fails for another reason is reported as it is, the tree left alone", async () => {
  const w = await world();
  try {
    await w.local.start();
    await w.local.stop();
    fs.writeFileSync(path.join(w.run, "stray.txt"), "a rebuild would drop this");
    process.env.ODM_TEST_EXIT = "3";
    try {
      await assert.rejects(w.local.start(), /exited during startup/);
    } finally {
      delete process.env.ODM_TEST_EXIT;
    }
    assert.ok(fs.existsSync(path.join(w.run, "stray.txt")), "no rebuild happened");
    assert.equal(w.local.status(false).state, "error");
    assert.match(w.local.status(false).error, /exited during startup/);
  } finally {
    await w.cleanup();
  }
});

test("a repair puts a torn file back, keeps the player's folders, and wakes the world again only when it was awake", async () => {
  const w = await world();
  try {
    await w.local.start();
    fs.writeFileSync(path.join(w.run, "helper.js"), "");
    fs.mkdirSync(path.join(w.run, "public", "uploads"), { recursive: true });
    fs.writeFileSync(path.join(w.run, "public", "uploads", "face.png"), "face");
    const awake = await w.local.repair();
    assert.deepEqual(awake, {
      found: { unpacked: true, listed: 2, missing: [], changed: ["helper.js"], hashed: false },
      started: true,
    });
    assert.equal(w.local.running, true);
    assert.equal(read(path.join(w.run, "helper.js")), HELPER);
    assert.equal(read(path.join(w.run, "public", "uploads", "face.png")), "face");

    await w.local.stop();
    const asleep = await w.local.repair();
    assert.deepEqual(asleep, { found: { unpacked: true, listed: 2, missing: [], changed: [], hashed: false }, started: false });
    assert.equal(w.local.running, false);
    assert.equal(read(path.join(w.run, "public", "uploads", "face.png")), "face");
  } finally {
    await w.cleanup();
  }
});

test("a start asked for during a repair waits for the rebuilt tree", async () => {
  const w = await world();
  try {
    await w.local.start();
    const repairing = w.local.repair();
    const starting = w.local.start();
    await Promise.all([repairing, starting]);
    assert.equal(w.local.running, true);
    assert.equal(read(path.join(w.run, "server.js")), SERVER);
  } finally {
    await w.cleanup();
  }
});
