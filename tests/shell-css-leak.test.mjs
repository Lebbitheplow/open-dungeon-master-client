import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The shell's sheets and the game's sheet share one page. The game's rules
// are layered (Tailwind) and the shell's are not, so a shell rule whose
// selector also matches inside the game root beats every utility there:
// the shell's `.panel { position: relative }` beat `fixed` on the new
// campaign wizard, which then sat in the page under its own backdrop
// (0.12.8). A shell selector made only of class names the game's sheet
// also knows must stop at the game root, the way the element rules do.

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rendererSrc = path.join(repo, "src", "renderer");
const gameCss = path.join(repo, "dist", "renderer", "game", "game.css");
const SHELL_SHEETS = ["style.css", "controls.css", "home.css"];
// The dust layer is the shell's, one for the whole app (index.html): the
// game's pages never draw their own inside the root.
const SHARED = new Set(["ambient-dust"]);

function classesIn(text) {
  return new Set([...text.matchAll(/\.(-?[a-zA-Z_][\w-]*)/g)].map((match) => match[1]));
}

// Every selector of every style rule, at-rule preludes and keyframe stops
// left out.
function selectorsOf(css) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/url\([^)]*\)/g, "url()");
  return [...bare.matchAll(/([^{}]+)\{/g)]
    .map((match) => match[1].trim())
    .filter((prelude) => prelude && !prelude.startsWith("@") && !/^(from|to|[\d.]+%)(\s*,\s*(from|to|[\d.]+%))*$/.test(prelude))
    .flatMap((prelude) => prelude.split(",").map((part) => part.trim()));
}

test("no shell class rule reaches into the game root", { skip: !fs.existsSync(gameCss) }, () => {
  const game = classesIn(fs.readFileSync(gameCss, "utf8").replace(/\{[^{}]*\}/g, "{}"));
  const leaks = [];
  for (const sheet of SHELL_SHEETS) {
    for (const selector of selectorsOf(fs.readFileSync(path.join(rendererSrc, sheet), "utf8"))) {
      if (selector.includes(".game-root")) continue;
      const classes = [...classesIn(selector)].filter((name) => !SHARED.has(name));
      if (classes.length && classes.every((name) => game.has(name))) leaks.push(`${sheet}: ${selector}`);
    }
  }
  assert.deepEqual(leaks, []);
});
