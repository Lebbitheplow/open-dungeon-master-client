// Bundles each TypeScript test with esbuild into a temp dir, then runs the
// Node test runner on the output. The sources are browser-flavored TS the
// desktop tsc build never sees, so this mirrors how build-www.mjs treats
// the bridge itself.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mobile = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testsDir = path.join(mobile, "tests");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-mobile-tests-"));

const entries = fs
  .readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => path.join(testsDir, name));

await build({
  entryPoints: entries,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
});

const built = fs
  .readdirSync(outDir)
  .filter((name) => name.endsWith(".mjs"))
  .map((name) => path.join(outDir, name));
const result = spawnSync(process.execPath, ["--test", ...built], { stdio: "inherit" });
fs.rmSync(outDir, { recursive: true, force: true });
process.exit(result.status ?? 1);
