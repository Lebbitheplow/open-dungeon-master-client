// Cuts a staged server payload down to what the server reaches at runtime.
//
// Next's standalone tracer copies the whole server worktree, not just what
// server.js loads (the process.cwd() reads in src/lib make every path look
// reachable), so a payload arrives with the repo's docs and plans, worker
// sources, scripts, CI config, Dockerfiles, env examples, agent notes and
// TypeScript. None of it runs inside the desktop app or on the phone, and
// all of it ships on every install unless it is dropped here. Both
// bundlers (scripts/bundle-server.mjs for the desktop payload and
// mobile/scripts/bundle-android-payload.mjs for the APK) call this, so the
// keep-list lives in one place.
import fs from "node:fs";
import path from "node:path";

// What the server needs at runtime, by top-level payload entry.
export const KEEP = new Set([
  ".next",
  "node_modules",
  "public",
  "models",
  "server.js",
  "package.json",
  "odm-payload.json",
  "LICENSE",
]);

// The one source directory the server reads from disk
// (src/lib/worlds/index.ts), so it survives while the rest of src goes.
export const KEEP_IN_SRC = path.join("lib", "worlds", "bundled");

// Removes everything outside the keep-list from `dir`. Returns the names of
// what was dropped, sorted, for the bundler's log.
export function pruneServerPayload(dir) {
  const dropped = [];
  for (const entry of fs.readdirSync(dir)) {
    if (KEEP.has(entry)) continue;
    const target = path.join(dir, entry);
    if (entry === "src") {
      const bundled = path.join(target, KEEP_IN_SRC);
      const parked = path.join(dir, ".worlds-bundled");
      if (fs.existsSync(bundled)) fs.renameSync(bundled, parked);
      fs.rmSync(target, { recursive: true, force: true });
      if (fs.existsSync(parked)) {
        fs.mkdirSync(path.dirname(bundled), { recursive: true });
        fs.renameSync(parked, bundled);
      }
      dropped.push("src (except " + KEEP_IN_SRC + ")");
      continue;
    }
    fs.rmSync(target, { recursive: true, force: true });
    dropped.push(entry);
  }
  return dropped.sort();
}
