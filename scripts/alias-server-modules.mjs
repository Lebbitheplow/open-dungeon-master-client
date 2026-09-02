// Repairs symlinks in the staged server payload at vendor/server. Two jobs:
//
// 1. Prune dangling links. The Next standalone tracer emits absolute
//    symlinks into the temp build dir (under .next/node_modules), dead the
//    moment the worktree is removed; electron-builder fails stat-ing them.
//    Module resolution never needs them: it walks up to the top-level
//    aliases instead.
// 2. Create the hashed-id aliases. Turbopack requires serverExternalPackages
//    under hash-suffixed ids (e.g. mediasoup-f2b066850faeed90) that the
//    standalone file tracer never materializes in node_modules. Every id
//    referenced from .next/server gets an alias link to the real package.
//
// Runs at the end of bundle-server.mjs locally, and again in each CI
// platform job right after unpacking the payload artifact, which ships
// symlink-free because Windows tar extraction cannot create posix
// symlinks. Junction-style links work unprivileged on Windows and behave
// as plain directory symlinks everywhere else.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vendorDir = path.join(repo, "vendor", "server");

if (!fs.existsSync(vendorDir)) {
  console.error(`No staged server payload at ${vendorDir}`);
  process.exit(1);
}

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    visit(full, entry);
    if (entry.isDirectory()) walk(full, visit);
  }
}

const dangling = [];
walk(vendorDir, (full, entry) => {
  if (!entry.isSymbolicLink()) return;
  try {
    fs.statSync(full);
  } catch {
    dangling.push(full);
  }
});
for (const link of dangling) {
  fs.rmSync(link);
  console.log(`Pruned dangling symlink ${path.relative(vendorDir, link)}`);
}

const hashedIds = new Set();
walk(path.join(vendorDir, ".next", "server"), (full, entry) => {
  if (entry.isDirectory() || !entry.name.endsWith(".js")) return;
  const text = fs.readFileSync(full, "utf8");
  // .x( is externalRequire, .y( is externalImport (dynamic).
  for (const [, id] of text.matchAll(/\.[xy]\("((?:@[\w.-]+\/)?[\w.-]+-[0-9a-f]{16})"/g)) {
    hashedIds.add(id);
  }
});
for (const id of hashedIds) {
  const real = id.replace(/-[0-9a-f]{16}$/, "");
  const target = path.join(vendorDir, "node_modules", real);
  const alias = path.join(vendorDir, "node_modules", id);
  if (!fs.existsSync(target) || fs.existsSync(alias)) continue;
  fs.mkdirSync(path.dirname(alias), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(alias), target), alias, "junction");
  console.log(`Aliased external ${id} -> ${real}`);
}
