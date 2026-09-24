import fs from "node:fs";
import path from "node:path";
import { localFolder, type LocalAssetManifest } from "../shared/local-assets";

// The desktop payload is staged (scripts/stage-desktop-payload.mjs) in a
// shape electron-builder will package whole, and this puts it back into the
// shape the server runs from. Two things differ between the two:
//
//  - Every node_modules directory is packaged under MODULES_DIR instead:
//    electron-builder silently drops a node_modules folder anywhere inside
//    extraResources, and the server cannot boot without its own.
//  - The hashed-id aliases Turbopack requires external packages under
//    (mediasoup-f2b066850faeed90 and the like) travel as a list in
//    ALIASES_FILE rather than as links, and become junction-style symlinks
//    here, which need no privilege on Windows either.
//
// And the art the shell already carries beside its game bundle
// (dist/renderer/game, listed in its manifest) is left out of the payload
// and copied back into the server's public tree, so it ships once.

export const MODULES_DIR = "modules";
export const ALIASES_FILE = "odm-module-aliases.json";

export type ModuleAliases = Record<string, string>;

// Copies `payloadDir` into `runDir` and restores it into a runnable server
// tree. `rendererDir` is where the shell's own bundle lives (dist/renderer,
// inside app.asar when packaged); when it has no manifest the payload is
// taken as complete.
export function materializeRunTree(payloadDir: string, runDir: string, rendererDir: string): void {
  fs.cpSync(payloadDir, runDir, { recursive: true });
  restoreModuleDirs(runDir);
  linkModuleAliases(runDir);
  restoreLocalAssets(runDir, rendererDir);
}

// Renames every MODULES_DIR back to node_modules, deepest first so a
// rename never invalidates a path still to be visited.
export function restoreModuleDirs(root: string): number {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      walk(full);
      if (entry.name === MODULES_DIR) found.push(full);
    }
  };
  walk(root);
  for (const dir of found) fs.renameSync(dir, path.join(path.dirname(dir), "node_modules"));
  return found.length;
}

export function linkModuleAliases(root: string): number {
  const file = path.join(root, ALIASES_FILE);
  if (!fs.existsSync(file)) return 0;
  const aliases = JSON.parse(fs.readFileSync(file, "utf8")) as ModuleAliases;
  const modules = path.join(root, "node_modules");
  let made = 0;
  for (const [alias, real] of Object.entries(aliases)) {
    const target = path.join(modules, real);
    const link = path.join(modules, alias);
    if (!fs.existsSync(target) || fs.existsSync(link)) continue;
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.relative(path.dirname(link), target), link, "junction");
    made += 1;
  }
  return made;
}

// Reads files one at a time rather than fs.cpSync: the source sits inside
// app.asar when packaged, which Electron's fs only patches for the plain
// read calls.
export function restoreLocalAssets(runDir: string, rendererDir: string): number {
  const manifestFile = path.join(rendererDir, "game", "public", "manifest.json");
  if (!fs.existsSync(manifestFile)) return 0;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as LocalAssetManifest;
  let copied = 0;
  for (const [hostDir, files] of Object.entries(manifest)) {
    const from = path.join(rendererDir, localFolder(hostDir));
    const to = path.join(runDir, "public", ...hostDir.split("/").filter(Boolean));
    fs.mkdirSync(to, { recursive: true });
    for (const file of files) {
      const source = path.join(from, file);
      if (!fs.existsSync(source)) continue;
      fs.writeFileSync(path.join(to, file), fs.readFileSync(source));
      copied += 1;
    }
  }
  return copied;
}
