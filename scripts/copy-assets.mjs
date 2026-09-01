// Copies the renderer's static assets next to its compiled script.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(repo, "dist", "renderer");
fs.mkdirSync(outDir, { recursive: true });
for (const name of ["index.html", "style.css"]) {
  fs.copyFileSync(path.join(repo, "src", "renderer", name), path.join(outDir, name));
}
