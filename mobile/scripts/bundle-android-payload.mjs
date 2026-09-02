// Stages what the Android app needs to host a world on the phone:
//
//   android/app/src/main/assets/server-payload.zip   the server, from the
//       desktop payload at ../vendor/server (npm run bundle-server at the
//       repo root) minus every native module, since the phone runs it on
//       Node's built-in SQLite and has no GPU workers or voice SFU
//   android/app/src/main/assets/server-payload.json  its odm-payload.json,
//       read on the phone before unzipping to decide whether to upgrade
//   android/app/src/main/jniLibs/<abi>/libnode.so    the Node runtime built
//       for Android (scripts/build-node-android.sh), taken from
//       runtime/node-android/<abi>/libnode.so
//
// Everything written here is a build artifact (gitignored). CI runs this
// after unpacking the shared payload artifact and fetching the runtime.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mobile = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repo = path.dirname(mobile);
const vendor = process.env.ODM_SERVER_PAYLOAD || path.join(repo, "vendor", "server");
const runtime = process.env.ODM_NODE_ANDROID || path.join(mobile, "runtime", "node-android");
const assets = path.join(mobile, "android", "app", "src", "main", "assets");
const jniLibs = path.join(mobile, "android", "app", "src", "main", "jniLibs");
const ABIS = ["arm64-v8a", "x86_64"];

// Native modules the phone cannot load; the server degrades without them
// (built-in SQLite, no embeddings, mesh voice only, no image transcoding).
const PRUNE = [
  "node_modules/better-sqlite3-multiple-ciphers",
  "node_modules/onnxruntime-node",
  "node_modules/mediasoup/worker",
  "node_modules/@img",
  "node_modules/sharp",
];

if (!fs.existsSync(path.join(vendor, "odm-payload.json"))) {
  console.error(`No server payload at ${vendor}; run "npm run bundle-server" at the repo root first.`);
  process.exit(1);
}

const staging = fs.mkdtempSync(path.join(mobile, ".payload-"));
try {
  // dereference: the payload's hashed-id aliases are symlinks, and a zip
  // unpacked by Java must hold real directories.
  fs.cpSync(vendor, staging, { recursive: true, dereference: true });
  for (const rel of PRUNE) {
    const target = path.join(staging, rel);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  }
  // Aliases of pruned packages would dangle after the prune; drop them too.
  const modules = path.join(staging, "node_modules");
  for (const entry of fs.readdirSync(modules)) {
    const match = /^(.*)-[0-9a-f]{16}$/.exec(entry);
    if (match && !fs.existsSync(path.join(modules, match[1]))) {
      fs.rmSync(path.join(modules, entry), { recursive: true, force: true });
    }
  }
  fs.mkdirSync(assets, { recursive: true });
  const zip = path.join(assets, "server-payload.zip");
  fs.rmSync(zip, { force: true });
  execFileSync("zip", ["-q", "-r", "-X", zip, "."], { cwd: staging, stdio: "inherit" });
  fs.copyFileSync(path.join(vendor, "odm-payload.json"), path.join(assets, "server-payload.json"));
  const size = (fs.statSync(zip).size / 1024 / 1024).toFixed(1);
  console.log(`Server payload zipped: ${size} MB`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}

// The runtime is the stripped node executable plus the NDK's libc++_shared
// it links against; both sit in the app's native library directory, which
// is also the child process's LD_LIBRARY_PATH.
const RUNTIME_FILES = ["libnode.so", "libc++_shared.so"];
let shipped = 0;
for (const abi of ABIS) {
  const sources = RUNTIME_FILES.map((name) => path.join(runtime, abi, name));
  if (!sources.every((file) => fs.existsSync(file))) {
    console.warn(`No complete Node runtime for ${abi} under ${runtime}; phones on that ABI will be connect-only.`);
    continue;
  }
  const dir = path.join(jniLibs, abi);
  fs.mkdirSync(dir, { recursive: true });
  for (const [index, name] of RUNTIME_FILES.entries()) {
    fs.copyFileSync(sources[index], path.join(dir, name));
  }
  shipped += 1;
  console.log(`Node runtime staged for ${abi}`);
}
if (!shipped) {
  console.error("No Node runtime staged for any ABI.");
  process.exit(1);
}
