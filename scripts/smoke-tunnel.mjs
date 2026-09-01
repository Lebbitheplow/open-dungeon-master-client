// The full hosting path, no GUI: boots the bundled server payload, opens a
// Cloudflare quick tunnel at it, then talks to the world THROUGH the public
// edge like a remote friend would: health, providers, account signup and
// bearer login. Uses a system cloudflared when present, otherwise downloads
// one to a cache directory (same code path the app uses).
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vendorDir = path.join(repo, "vendor", "server");
const electronPath = createRequire(import.meta.url)("electron");

if (!fs.existsSync(path.join(vendorDir, "server.js"))) {
  console.error("No payload at vendor/server. Run: npm run bundle-server");
  process.exit(1);
}

async function cloudflaredPath() {
  try {
    const found = execFileSync("which", ["cloudflared"], { encoding: "utf8" }).trim();
    if (found) return found;
  } catch {
    // Not installed; download below.
  }
  const cached = path.join(os.homedir(), ".cache", "odm-client", "cloudflared");
  if (fs.existsSync(cached)) return cached;
  console.log("downloading cloudflared...");
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const response = await fetch(
    `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`,
    { redirect: "follow" },
  );
  if (!response.ok || !response.body) throw new Error("cloudflared download failed");
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(cached, { mode: 0o755 }));
  return cached;
}

const port = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen({ host: "127.0.0.1", port: 0 }, () => {
    const chosen = probe.address().port;
    probe.close(() => resolve(chosen));
  });
});
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-tunnel-smoke-"));

const server = spawn(electronPath, [path.join(vendorDir, "server.js")], {
  cwd: vendorDir,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    SQLITE_DB_PATH: path.join(dataDir, "smoke.sqlite"),
    DB_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  },
  stdio: ["ignore", "ignore", "ignore"],
});

let cloudflared = null;

function cleanup() {
  cloudflared?.kill("SIGKILL");
  server.kill("SIGKILL");
  fs.rmSync(dataDir, { recursive: true, force: true });
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  cleanup();
  process.exit(1);
}

async function until(deadlineMs, step, what) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const result = await step().catch(() => null);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail(`timed out waiting for ${what}`);
}

await until(
  60_000,
  async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok || null,
  "local health",
);
console.log("ok: local server healthy");

const bin = await cloudflaredPath();
cloudflared = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], {
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
const urlPromise = new Promise((resolve) => {
  const scan = (chunk) => {
    logs += chunk.toString();
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(logs);
    if (match) resolve(match[0]);
  };
  cloudflared.stdout.on("data", scan);
  cloudflared.stderr.on("data", scan);
});
const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 60_000));
const publicUrl = await Promise.race([urlPromise, timeout]);
if (!publicUrl) fail(`tunnel URL never appeared. Logs:\n${logs.slice(-2000)}`);
console.log(`ok: tunnel assigned ${publicUrl}`);

// Confirm the fresh hostname exists via DoH BEFORE any local-resolver
// lookup, or systemd-resolved negative-caches the NXDOMAIN and every
// fetch below fails for minutes.
await until(
  90_000,
  async () => {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${new URL(publicUrl).hostname}&type=A`,
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(4000) },
    );
    const body = await response.json();
    return Array.isArray(body.Answer) && body.Answer.length > 0 ? true : null;
  },
  "tunnel DNS via DoH",
);
console.log("ok: tunnel hostname visible in DNS");

let lastEdge = "no response";
const deadline = Date.now() + 120_000;
let edgeOk = false;
while (Date.now() < deadline && !edgeOk) {
  if (server.exitCode !== null) fail("the local server died during edge polling");
  try {
    const response = await fetch(`${publicUrl}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    lastEdge = `${response.status} ${(await response.text()).slice(0, 200)}`;
    edgeOk = response.ok;
  } catch (err) {
    lastEdge = String(err);
  }
  if (!edgeOk) await new Promise((resolve) => setTimeout(resolve, 1500));
}
if (!edgeOk) fail(`edge reachability: last response was: ${lastEdge}\ntunnel logs:\n${logs.slice(-1500)}`);
console.log("ok: /api/health through the Cloudflare edge");

const providers = await (await fetch(`${publicUrl}/api/auth/providers`)).json();
if (providers.password !== true) fail("providers probe through the edge looks wrong");
console.log(`ok: providers through the edge (signupMode ${providers.signupMode})`);

const register = await fetch(`${publicUrl}/api/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "remotefriend", password: "friend-pass-123" }),
});
if (register.status !== 201) fail(`remote signup returned ${register.status}`);
console.log("ok: a remote friend can create an account");

const token = await fetch(`${publicUrl}/api/auth/token`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "remotefriend", password: "friend-pass-123" }),
});
const grant = await token.json();
if (!token.ok || !grant.token) fail(`remote token mint returned ${token.status}`);
const me = await fetch(`${publicUrl}/api/auth/me`, {
  headers: { authorization: `Bearer ${grant.token}` },
});
if (!me.ok) fail(`remote bearer auth returned ${me.status}`);
console.log("ok: remote bearer login works");

console.log("TUNNEL SMOKE PASS");
cleanup();
