import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The shell pages load tsc output straight from disk. tsc emits a trailing
// "export {}" for any file that only imports types, which a classic
// <script> rejects with "Unexpected token 'export'" and the shell dies
// before drawing anything (the 0.2.0 desktop blank screen). Every compiled
// renderer script must therefore be loaded as a module.

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rendererSrc = path.join(repo, "src", "renderer");
const rendererDist = path.join(repo, "dist", "renderer");

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
    const file = path.join(rendererDist, name);
    assert.ok(fs.existsSync(file), `${name} missing from dist/renderer`);
    const source = fs.readFileSync(file, "utf8");
    // A module-only construct is fine now; a CommonJS require would not be.
    assert.doesNotMatch(source, /\brequire\(/, `${name} uses require()`);
  }
});
