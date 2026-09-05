// The payload prune keeps what the server runs and drops what the repo
// carries: docs and plans, scripts, sources, agent notes, CI and Docker
// files. Both bundlers rely on it, so the claim is checked on a staged tree.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { KEEP, KEEP_IN_SRC, pruneServerPayload } from "../scripts/prune-server-payload.mjs";

function stage(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-prune-"));
  for (const rel of entries) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "x");
  }
  return dir;
}

test("everything outside the keep-list goes, and the bundled worlds survive", () => {
  const dir = stage([
    ".next/server/app/page.js",
    "node_modules/next/package.json",
    "public/assets/placeholders/plain.webp",
    "server.js",
    "package.json",
    "odm-payload.json",
    "LICENSE",
    "docs/workshop-parity-audit.md",
    "docs/ROADMAP.md",
    "scripts/test-all.mjs",
    "workers/j-redirector/index.js",
    "src/lib/worlds/bundled/high-fantasy.json",
    "src/lib/db/core.ts",
    "src/app/page.tsx",
    "README.md",
    "CLAUDE.md",
    "AGENTS.md",
    "Dockerfile",
    ".env.example",
    ".github/workflows/ci.yml",
    "package-lock.json",
  ]);
  try {
    const dropped = pruneServerPayload(dir);
    const left = fs.readdirSync(dir).sort();
    assert.deepEqual(left, [
      ".next",
      "LICENSE",
      "node_modules",
      "odm-payload.json",
      "package.json",
      "public",
      "server.js",
      "src",
    ]);
    for (const entry of left) {
      assert.ok(entry === "src" || KEEP.has(entry), `${entry} survived without being kept`);
    }
    assert.ok(fs.existsSync(path.join(dir, "src", KEEP_IN_SRC, "high-fantasy.json")));
    assert.ok(!fs.existsSync(path.join(dir, "src", "lib", "db")));
    assert.ok(!fs.existsSync(path.join(dir, "src", "app")));
    assert.ok(dropped.includes("docs"));
    assert.ok(dropped.includes("CLAUDE.md"));
    assert.ok(dropped.includes("src (except " + KEEP_IN_SRC + ")"));
    // Sorted, so the bundler's log line is stable.
    assert.deepEqual(dropped, [...dropped].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a payload with no src at all prunes without complaint", () => {
  const dir = stage(["server.js", "package.json", "docs/plan.md"]);
  try {
    assert.deepEqual(pruneServerPayload(dir), ["docs"]);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["package.json", "server.js"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
