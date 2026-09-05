// Copies the renderer's static assets next to its compiled script: the
// pages, the stylesheet, the wordmark tile, and the Cinzel display face the
// shell shares with the game (vendored from @fontsource so the packaged app
// never reaches for a font host).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(repo, "dist", "renderer");
fs.mkdirSync(outDir, { recursive: true });
for (const name of [
  "index.html",
  "bluetooth-picker.html",
  "style.css",
  "controls.css",
  "home.css",
  "story.png",
]) {
  fs.copyFileSync(path.join(repo, "src", "renderer", name), path.join(outDir, name));
}

export const FONT_FILES = [
  "cinzel-latin-400-normal.woff2",
  "cinzel-latin-600-normal.woff2",
  "cinzel-latin-700-normal.woff2",
];

export function copyFonts(target) {
  const source = path.join(repo, "node_modules", "@fontsource", "cinzel", "files");
  fs.mkdirSync(target, { recursive: true });
  for (const name of FONT_FILES) {
    fs.copyFileSync(path.join(source, name), path.join(target, name));
  }
}

copyFonts(path.join(outDir, "fonts"));
