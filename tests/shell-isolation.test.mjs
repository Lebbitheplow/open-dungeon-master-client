import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import Module from "node:module";
import { serverDir as findServerDir } from "../scripts/server-dir.mjs";

// isolation.js imports electron for net and the session type; a stub stands
// in under node and records what the module asks of it.
const fetched = [];
const net = {
  fetch: async (request, options) => {
    fetched.push({ url: request.url, options });
    return new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } });
  },
};
const require = createRequire(import.meta.url);
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { net };
  return load.call(this, request, ...rest);
};
const { isolateShellPages, withIsolation } = require("../dist/main/isolation.js");
Module._load = load;

test("a file the app loads keeps its body and type and gains the two isolation headers", async () => {
  const isolated = withIsolation(new Response("body", { status: 206, statusText: "Partial", headers: { "Content-Type": "audio/ogg", "Content-Range": "bytes 0-3/9" } }));
  assert.equal(isolated.status, 206);
  assert.equal(isolated.headers.get("Content-Type"), "audio/ogg");
  assert.equal(isolated.headers.get("Content-Range"), "bytes 0-3/9");
  assert.equal(isolated.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  // credentialless, not require-corp: a host's public pictures load as before.
  assert.equal(isolated.headers.get("Cross-Origin-Embedder-Policy"), "credentialless");
  assert.equal(await isolated.text(), "body");
});

test("the session's file:// loads go through the handler, which reads the file itself", async () => {
  const handlers = new Map();
  isolateShellPages({ protocol: { handle: (scheme, handler) => handlers.set(scheme, handler) } });
  assert.deepEqual([...handlers.keys()], ["file"]);
  const response = await handlers.get("file")(new Request("file:///app/renderer/index.html?table=1"));
  assert.equal(response.headers.get("Cross-Origin-Embedder-Policy"), "credentialless");
  assert.equal(fetched.at(-1).url, "file:///app/renderer/index.html?table=1");
  // The real file, not this handler again.
  assert.equal(fetched.at(-1).options.bypassCustomProtocolHandlers, true);
});

test("the server pages this app is built from make the board view frame credentialless", () => {
  // Without it, an isolated shell refuses the view of every server older
  // than the frame's own embedder policy: the two ship together.
  const repo = path.resolve(import.meta.dirname, "..");
  const serverDir = findServerDir(repo);
  const view = fs.readFileSync(path.join(serverDir, "src", "app", "campaigns", "[campaignId]", "AddonBoardView.tsx"), "utf8");
  assert.match(view, /credentialless/);
});
