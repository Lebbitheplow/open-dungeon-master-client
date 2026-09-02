// Renders every app icon from the one logo source, build/icon.svg (the same
// gold d20 the server serves as its favicon and PWA icon). Run after the svg
// changes: node scripts/make-icons.mjs
//
// Outputs:
// - build/icon.png: 1024px with transparent rounded corners. electron-builder
//   derives the Linux, Windows (.ico) and macOS (.icns) icons from it, and
//   the desktop shell ships a copy as its window icon (see electron-builder.yml
//   extraResources and src/main/window.ts).
// - Android launcher mipmaps: legacy square, round, and the adaptive
//   foreground layer (the d20 alone, sized into the 66% safe zone; the
//   background layer is the solid color in values/ic_launcher_background.xml).
// - Android splash drawables: the d20 centered on the arcane-night background
//   at every density Capacitor's template ships.
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const svgPath = path.join(root, "build/icon.svg");
const res = path.join(root, "mobile/android/app/src/main/res");
const BG = "#181420";

const fullSvg = await readFile(svgPath, "utf8");
// The d20 without its rounded plate, for layers that supply their own
// background (adaptive foreground, round icon, splash).
const glyphSvg = fullSvg.replace(/<rect[^>]*\/>\s*/, "");

// The svg is 64 user units square; sharp renders at 72 dpi by default, so the
// density scales it to the requested pixel size before an exact resize.
function renderSvg(svg, size) {
  return sharp(Buffer.from(svg), { density: (72 * size) / 64 })
    .resize(size, size)
    .png()
    .toBuffer();
}

// The glyph centered on a canvas, scaled to `scale` of the shorter side.
async function composed(width, height, scale, background) {
  const inner = Math.round(Math.min(width, height) * scale);
  const glyph = await renderSvg(glyphSvg, inner);
  return sharp({ create: { width, height, channels: 4, background } })
    .composite([
      { input: glyph, left: Math.round((width - inner) / 2), top: Math.round((height - inner) / 2) },
    ])
    .png();
}

async function write(pipeline, relPath) {
  const out = path.join(root, relPath);
  await mkdir(path.dirname(out), { recursive: true });
  await pipeline.toFile(out);
  console.log(`wrote ${relPath}`);
}

// Desktop.
await write(sharp(await renderSvg(fullSvg, 1024)), "build/icon.png");

// Android launcher. Densities and the pixel sizes of a 48dp icon and a 108dp
// adaptive layer at each.
const densities = [
  ["mdpi", 48, 108],
  ["hdpi", 72, 162],
  ["xhdpi", 96, 216],
  ["xxhdpi", 144, 324],
  ["xxxhdpi", 192, 432],
];
for (const [name, launcher, adaptive] of densities) {
  const dir = path.relative(root, path.join(res, `mipmap-${name}`));
  await write(sharp(await renderSvg(fullSvg, launcher)), `${dir}/ic_launcher.png`);
  // Round: the plate becomes a disc, the d20 sits inside it.
  const disc = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="${BG}"/></svg>`,
  );
  const glyph = await renderSvg(glyphSvg, Math.round(launcher * 0.82));
  const offset = Math.round((launcher - Math.round(launcher * 0.82)) / 2);
  await write(
    sharp(await renderSvg(disc.toString(), launcher)).composite([
      { input: glyph, left: offset, top: offset },
    ]),
    `${dir}/ic_launcher_round.png`,
  );
  // Adaptive foreground: transparent, glyph inside the safe zone so squircle
  // and circle masks never clip the die.
  await write(
    await composed(adaptive, adaptive, 0.6, { r: 0, g: 0, b: 0, alpha: 0 }),
    `${dir}/ic_launcher_foreground.png`,
  );
}

// Android splash, same sizes as the Capacitor template it replaces.
const splashes = [
  ["drawable", 480, 320],
  ["drawable-land-mdpi", 480, 320],
  ["drawable-land-hdpi", 800, 480],
  ["drawable-land-xhdpi", 1280, 720],
  ["drawable-land-xxhdpi", 1600, 960],
  ["drawable-land-xxxhdpi", 1920, 1280],
  ["drawable-port-mdpi", 320, 480],
  ["drawable-port-hdpi", 480, 800],
  ["drawable-port-xhdpi", 720, 1280],
  ["drawable-port-xxhdpi", 960, 1600],
  ["drawable-port-xxxhdpi", 1280, 1920],
];
for (const [dir, width, height] of splashes) {
  await write(
    (await composed(width, height, 0.3, BG)).flatten({ background: BG }),
    path.relative(root, path.join(res, dir, "splash.png")),
  );
}
