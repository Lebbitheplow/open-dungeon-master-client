// Builds the Open Dungeon Master server as a Next.js standalone bundle and
// stages it under vendor/server, ready to ship inside the desktop app for
// offline play. Builds from a clean git worktree of the server repo so the
// server checkout's own .next (often serving a live instance) is untouched.
//
//   ODM_SERVER_DIR=/path/to/open-dungeon-master npm run bundle-server
//
// The native better-sqlite3 module is rebuilt for Electron's ABI, because the
// bundled server runs under the Electron binary in Node mode.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverDir = path.resolve(
  process.env.ODM_SERVER_DIR ?? path.join(repo, "..", "open-dungeon-master"),
);
const vendorDir = path.join(repo, "vendor", "server");

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

if (!fs.existsSync(path.join(serverDir, "package.json"))) {
  console.error(`No server checkout at ${serverDir}. Set ODM_SERVER_DIR.`);
  process.exit(1);
}

const serverPkg = JSON.parse(fs.readFileSync(path.join(serverDir, "package.json"), "utf8"));
const electronPkg = JSON.parse(
  fs.readFileSync(path.join(repo, "node_modules", "electron", "package.json"), "utf8"),
);
const commit = execFileSync("git", ["-C", serverDir, "rev-parse", "--short", "HEAD"], {
  encoding: "utf8",
}).trim();

// Build on the same filesystem as the server checkout: node_modules is
// brought over with a reflink copy (Turbopack rejects a symlink that points
// outside the project root), which is nearly free on btrfs/XFS and degrades
// to a real copy elsewhere.
const buildRoot = process.env.ODM_BUILD_DIR ?? path.join(os.homedir(), ".cache");
fs.mkdirSync(buildRoot, { recursive: true });
const buildDir = fs.mkdtempSync(path.join(buildRoot, "odm-server-build-"));
fs.rmdirSync(buildDir);
console.log(`Building server ${serverPkg.version} (${commit}) in ${buildDir}`);
run("git", ["-C", serverDir, "worktree", "add", "--detach", buildDir, "HEAD"]);

try {
  run("cp", [
    "-a",
    "--reflink=auto",
    path.join(serverDir, "node_modules"),
    path.join(buildDir, "node_modules"),
  ]);
  // The postinstall step copies dice assets into public/, which git ignores.
  run(process.execPath, ["scripts/copy-dice-assets.mjs"], { cwd: buildDir });
  run(path.join(buildDir, "node_modules", ".bin", "next"), ["build"], {
    cwd: buildDir,
    env: { ...process.env, DOCKER_BUILD: "1" },
  });

  fs.rmSync(vendorDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(vendorDir), { recursive: true });
  fs.cpSync(path.join(buildDir, ".next", "standalone"), vendorDir, { recursive: true });
  fs.cpSync(path.join(buildDir, ".next", "static"), path.join(vendorDir, ".next", "static"), {
    recursive: true,
  });
  fs.cpSync(path.join(buildDir, "public"), path.join(vendorDir, "public"), { recursive: true });

  fs.writeFileSync(
    path.join(vendorDir, "odm-payload.json"),
    JSON.stringify(
      {
        serverVersion: serverPkg.version,
        commit,
        builtAt: new Date().toISOString(),
        electron: electronPkg.version,
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(path.join(buildDir, "node_modules"), { recursive: true, force: true });
  run("git", ["-C", serverDir, "worktree", "remove", "--force", buildDir]);
}

// Prune the dangling symlinks the standalone tracer leaves behind and
// create the hashed-id aliases Turbopack's serverExternalPackages need;
// CI platform jobs rerun the same script after unpacking the payload.
run(process.execPath, ["scripts/alias-server-modules.mjs"], { cwd: repo });

console.log(`Rebuilding native modules for Electron ${electronPkg.version}`);
run(
  path.join(repo, "node_modules", ".bin", "electron-rebuild"),
  ["--version", electronPkg.version, "--module-dir", vendorDir, "--force", "--only", "better-sqlite3-multiple-ciphers"],
  { cwd: repo },
);

const size = execFileSync("du", ["-sh", vendorDir], { encoding: "utf8" }).split("\t")[0];
console.log(`Payload staged at vendor/server (${size})`);
