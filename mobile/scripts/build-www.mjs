// Builds the Capacitor web assets. The manager UI is the same app.ts the
// desktop shell uses (it only talks to window.odm); the Capacitor bridge
// implementation is bundled in front of it.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mobile = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repo = path.dirname(mobile);
const www = path.join(mobile, "www");

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });

await build({
  entryPoints: [path.join(mobile, "src", "bridge.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  outfile: path.join(www, "bridge.js"),
});

// The Web Bluetooth polyfill is not loaded by the manager UI; the bridge
// fetches it as text and injects it into the game webview (preShowScript).
await build({
  entryPoints: [path.join(mobile, "src", "ble-polyfill.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  outfile: path.join(www, "ble-polyfill.js"),
});

await build({
  entryPoints: [path.join(repo, "src", "renderer", "app.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  outfile: path.join(www, "app.js"),
});

fs.copyFileSync(path.join(repo, "src", "renderer", "style.css"), path.join(www, "style.css"));
fs.copyFileSync(path.join(mobile, "src", "index.html"), path.join(www, "index.html"));
console.log("www built");
