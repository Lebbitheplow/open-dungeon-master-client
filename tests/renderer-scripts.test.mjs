import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The shell pages load tsc output straight from disk. tsc emits a trailing
// "export {}" for any file that only imports types, which a classic
// <script> rejects with "Unexpected token 'export'" and the shell dies
// before drawing anything (the 0.2.0 desktop blank screen). Every compiled
// renderer script must therefore be loaded as a module, and none of them
// may lean on CommonJS.

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rendererSrc = path.join(repo, "src", "renderer");
const rendererDist = path.join(repo, "dist", "renderer");
const mobileSrc = path.join(repo, "mobile", "src");

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function linked(html, pattern) {
  return [...html.matchAll(pattern)].map((match) => path.basename(match[1])).sort();
}

test("every renderer page loads its scripts as modules", () => {
  for (const page of fs.readdirSync(rendererSrc).filter((name) => name.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(rendererSrc, page), "utf8");
    for (const [tag] of html.matchAll(/<script[^>]*src=[^>]*>/g)) {
      assert.match(tag, /type="module"/, `${page}: ${tag}`);
    }
  }
});

test("compiled renderer scripts exist and would parse as modules", () => {
  for (const name of ["app.js", "topo.js", "bluetooth-picker.js"]) {
    assert.ok(fs.existsSync(path.join(rendererDist, name)), `${name} missing from dist/renderer`);
  }
  const scripts = walk(rendererDist).filter((file) => file.endsWith(".js"));
  assert.ok(scripts.length >= 3, "dist/renderer has no compiled scripts");
  for (const file of scripts) {
    const source = fs.readFileSync(file, "utf8");
    // A module-only construct is fine now; a CommonJS require would not be.
    assert.doesNotMatch(source, /\brequire\(/, `${path.relative(repo, file)} uses require()`);
  }
});

test("renderer modules import each other with .js suffixes", () => {
  // The desktop shell resolves imports from disk, where only the compiled
  // .js exists; esbuild follows the same paths for Android.
  for (const file of walk(rendererSrc).filter((name) => name.endsWith(".ts"))) {
    const source = fs.readFileSync(file, "utf8");
    for (const [, spec] of source.matchAll(/^import (?!type )[^"']*["']([^"']+)["']/gm)) {
      assert.match(spec, /\.js$/, `${path.basename(file)} imports ${spec} without .js`);
    }
  }
});

test("the desktop and Android pages link the same scripts and stylesheets", () => {
  const desktop = fs.readFileSync(path.join(rendererSrc, "index.html"), "utf8");
  const android = fs.readFileSync(path.join(mobileSrc, "index.html"), "utf8");
  const styles = /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g;
  const scripts = /<script[^>]*src="([^"]+)"/g;
  assert.deepEqual(linked(android, styles), linked(desktop, styles));
  // bridge.js is Android's stand-in for the desktop preload; every other
  // script must match.
  assert.deepEqual(
    linked(android, scripts).filter((name) => name !== "bridge.js"),
    linked(desktop, scripts),
  );
  // Whatever the pages link must actually be copied beside them.
  for (const name of linked(desktop, styles)) {
    assert.ok(fs.existsSync(path.join(rendererDist, name)), `${name} not copied to dist/renderer`);
  }
});
