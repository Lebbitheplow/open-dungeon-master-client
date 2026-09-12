// Bundles the shell's renderer with esbuild:
//
// - the page scripts (app, topo, the Bluetooth picker), one ESM each;
// - the game bundle (src/renderer/game): the host's own page components,
//   taken straight from the sibling server checkout (ODM_SERVER_DIR, the
//   same one bundle-server.mjs builds the payload from), compiled against
//   Preact through its compat layer with shims for the Next.js bits, and
//   code-split per page;
// - game.css: Tailwind over those components plus the server's theme.
//
// Type checking stays with tsc (tsconfig.renderer.json, noEmit); this only
// emits. The Android build (mobile/scripts/build-www.mjs) reuses the same
// options and entries into its www folder.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scopeCss } from "./scope-css.mjs";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const RENDERER_ENTRIES = ["app", "topo", "bluetooth-picker"];

export function serverDir() {
  const dir = path.resolve(process.env.ODM_SERVER_DIR ?? path.join(repo, "..", "open-dungeon-master"));
  if (!fs.existsSync(path.join(dir, "src", "app", "page.tsx"))) {
    throw new Error(`No server checkout at ${dir}. Set ODM_SERVER_DIR.`);
  }
  return dir;
}

// Shared by both shells so they compile the same way.
export const rendererBuildOptions = {
  bundle: true,
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "preact",
  logLevel: "warning",
  // The bundles are parsed from local files on every launch and on every
  // entry into a world; minified they are about half the bytes to parse.
  minify: true,
};

const shims = path.join(repo, "src", "renderer", "game", "shims");

// The game bundle's view of the world: React is Preact, Next's pieces are
// the shims, "@/" is the server's src.
export function gameBuildOptions(server) {
  return {
    ...rendererBuildOptions,
    format: "esm",
    splitting: true,
    alias: {
      react: path.join(shims, "react.js"),
      "react-dom": path.join(shims, "react-dom.js"),
      "react-dom/client": "preact/compat",
      "react/jsx-runtime": "preact/jsx-runtime",
      "react/jsx-dev-runtime": "preact/jsx-runtime",
      "next/link": path.join(shims, "next-link.tsx"),
      "next/navigation": path.join(shims, "next-navigation.ts"),
      "node:crypto": path.join(shims, "node-crypto.ts"),
      "@radix-ui/react-portal": path.join(shims, "radix-portal.tsx"),
      "@": path.join(server, "src"),
    },
    define: { "process.env.NODE_ENV": '"production"' },
    // The server's sources import from its own node_modules (radix, lucide,
    // zod...); the same packages are installed here, so resolution is
    // pinned to this repo and falls back to the server's copy.
    nodePaths: [path.join(repo, "node_modules"), path.join(server, "node_modules")],
    entryPoints: [path.join(repo, "src", "renderer", "game", "index.tsx")],
    entryNames: "game",
    chunkNames: "chunks/[name]-[hash]",
  };
}

// Tailwind over the server's components and the game shims, with the
// server's own theme. The input is written beside the output because
// @source paths are relative to the file that holds them.
export function buildGameCss(server, outDir) {
  const entry = path.join(outDir, "game-entry.css");
  const rel = (target) => path.relative(outDir, target).split(path.sep).join("/");
  // The server's stylesheet is copied in rather than imported: its own
  // `@import "tailwindcss"` must resolve from this repo's node_modules,
  // since the server checkout beside it (CI) has none installed.
  const globals = fs.readFileSync(path.join(server, "src", "app", "globals.css"), "utf8");
  fs.writeFileSync(
    entry,
    [
      globals,
      `@source "${rel(path.join(server, "src", "app"))}";`,
      `@source "${rel(path.join(server, "src", "components"))}";`,
      `@source "${rel(path.join(server, "src", "lib"))}";`,
      `@source "${rel(path.join(repo, "src", "renderer", "game"))}";`,
      "",
    ].join("\n"),
  );
  const cli = path.join(repo, "node_modules", "@tailwindcss", "cli", "dist", "index.mjs");
  const out = path.join(outDir, "game.css");
  execFileSync(process.execPath, [cli, "-i", entry, "-o", out, "--minify"], { stdio: "inherit" });
  fs.rmSync(entry, { force: true });
  // The sheet shares the page with the shell's own screens: every rule is
  // confined to the game's root element (scope-css.mjs).
  fs.writeFileSync(out, scopeCss(fs.readFileSync(out, "utf8"), ".game-root"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = path.join(repo, "dist", "renderer");
  for (const name of RENDERER_ENTRIES) {
    await build({
      ...rendererBuildOptions,
      entryPoints: [path.join(repo, "src", "renderer", `${name}.ts`)],
      format: "esm",
      outfile: path.join(outDir, `${name}.js`),
    });
  }
  const server = serverDir();
  fs.rmSync(path.join(outDir, "game"), { recursive: true, force: true });
  await build({ ...gameBuildOptions(server), outdir: path.join(outDir, "game") });
  buildGameCss(server, path.join(outDir, "game"));
  console.log("renderer bundled");
}
