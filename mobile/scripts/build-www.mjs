// Builds the Capacitor web assets. The manager UI is the same app.ts the
// desktop shell uses (it only talks to window.odm); the Capacitor bridge
// implementation is bundled in front of it.
import { build } from "esbuild";
import fs from "node:fs";
import { createRequire } from "node:module";
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

// The game-page scripts (Web Bluetooth polyfill, download shim, shell menu
// hook) are not loaded by the manager UI; the bridge fetches them as text
// and injects them into the game webview (preShowScript).
for (const name of ["ble-polyfill", "download-shim", "shell-hook"]) {
  await build({
    entryPoints: [path.join(mobile, "src", `${name}.ts`)],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: path.join(www, `${name}.js`),
  });
}

for (const name of ["app", "topo"]) {
  await build({
    entryPoints: [path.join(repo, "src", "renderer", `${name}.ts`)],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: path.join(www, `${name}.js`),
  });
}

for (const name of ["style.css", "controls.css", "home.css", "story.png"]) {
  fs.copyFileSync(path.join(repo, "src", "renderer", name), path.join(www, name));
}
fs.copyFileSync(path.join(mobile, "src", "index.html"), path.join(www, "index.html"));

// Same display face as the desktop shell. Resolved as a module so it works
// from the mobile package's own node_modules (CI installs only those) or
// the repo root's.
const fontSource = path.join(
  path.dirname(createRequire(import.meta.url).resolve("@fontsource/cinzel/package.json")),
  "files",
);
fs.mkdirSync(path.join(www, "fonts"), { recursive: true });
for (const weight of ["400", "600", "700"]) {
  const name = `cinzel-latin-${weight}-normal.woff2`;
  fs.copyFileSync(path.join(fontSource, name), path.join(www, "fonts", name));
}
console.log("www built");
