// Proves the round trip that 0.7.16 exists for: a host shares a world, a
// friend joins by room code and makes a character, the host closes the world
// and shares it again at a DIFFERENT address, and the friend gets back in as
// the same account and the same character, with no sign-in and no second
// account.
//
// Real parts: the bundled server payload (booted the way the packaged app
// boots it, twice from the same database on two different ports, which is
// what a new tunnel hostname is to the shell), the desktop shell's own
// modules from dist/ (ServerStore, the API helpers, the table registry
// client, the home feed and relocate.ts). The only stand-in is the broker's
// table registry, which runs here as a small HTTP server with the deployed
// Worker's claim/re-point/drop rules, so the run never touches the live
// registry. No GUI.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vendorDir = path.join(repo, "vendor", "server");
const electronPath = createRequire(import.meta.url)("electron");

if (!fs.existsSync(path.join(vendorDir, "server.js"))) {
  console.error("No payload at vendor/server. Run: npm run bundle-server");
  process.exit(1);
}

const cleanup = [];
function fail(message) {
  console.error(`FAIL: ${message}`);
  for (const fn of cleanup.splice(0)) {
    try {
      fn();
    } catch {
      // Best effort on the way out.
    }
  }
  process.exit(1);
}
function ok(message) {
  console.log(`ok: ${message}`);
}
function assert(condition, message) {
  if (!condition) fail(message);
}

async function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen({ host: "127.0.0.1", port: 0 }, () => {
      const chosen = probe.address().port;
      probe.close(() => resolve(chosen));
    });
  });
}

// ---------- the stand-in table registry ----------
// Mirrors workers/tunnel-broker: first PUT claims a code with its secret,
// the same secret re-points it, any other secret is refused, DELETE takes
// it offline, GET is public and answers 404 while nothing is online.
const tables = new Map();
const broker = http.createServer((req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const match = /^\/table\/([A-Z0-9]+)$/.exec(req.url ?? "");
  if (!match) return reply(404, { error: "Not found." });
  const code = match[1];
  const secret = String(req.headers["x-table-secret"] ?? "");
  let data = "";
  req.on("data", (chunk) => (data += chunk));
  req.on("end", () => {
    const entry = tables.get(code);
    if (req.method === "GET") {
      return entry?.url ? reply(200, { code, url: entry.url }) : reply(404, { error: "offline" });
    }
    if (req.method === "PUT") {
      if (secret.length < 16) return reply(400, { error: "Bad table secret." });
      if (entry && entry.secret !== secret) return reply(409, { error: "claimed" });
      let url = "";
      try {
        url = new URL(JSON.parse(data).url).origin;
      } catch {
        return reply(400, { error: "bad url" });
      }
      tables.set(code, { url, secret });
      return reply(200, { code, url });
    }
    if (req.method === "DELETE") {
      if (entry && entry.secret !== secret) return reply(409, { error: "claimed" });
      tables.delete(code);
      return reply(200, { code, dropped: true });
    }
    return reply(405, { error: "method" });
  });
});
const brokerPort = await freePort();
await new Promise((resolve) => broker.listen(brokerPort, "127.0.0.1", resolve));
cleanup.push(() => broker.close());
process.env.ODM_BROKER_URL = `http://127.0.0.1:${brokerPort}`;

// The shell's own modules, loaded once the registry address is in place.
const { ServerStore } = await import("../dist/main/servers.js");
const { loginForToken, probeServer, registerAccount, tokenIsValid } = await import(
  "../dist/main/odm-api.js"
);
const { dropTables, ownedTableCodes, publishTables, resolveTable } = await import(
  "../dist/main/table-registry.js"
);
const { relocateWorld } = await import("../dist/shared/relocate.js");
const { createDesktopHomeFeed } = await import("../dist/main/home-feed.js");

// ---------- a device world, booted like the packaged app boots it ----------
async function bootWorld(dataDir, dbKey) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(electronPath, [path.join(vendorDir, "server.js")], {
    cwd: vendorDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      SQLITE_DB_PATH: path.join(dataDir, "world.sqlite"),
      DB_ENCRYPTION_KEY: dbKey,
      ODM_DEVICE_WORLD: "1",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await new Promise((resolve) => child.once("exit", resolve));
    clearTimeout(killer);
  };
  cleanup.push(() => child.kill("SIGKILL"));
  const deadline = Date.now() + 90_000;
  let healthy = false;
  while (Date.now() < deadline && !healthy) {
    if (child.exitCode !== null) fail(`world exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) });
      healthy = res.ok;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!healthy) fail("world never became healthy");
  return { origin, stop };
}

async function json(origin, pathname, token, init = {}) {
  const res = await fetch(`${origin}${pathname}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const crypt = {
  encrypt: (plain) => `enc:${plain}`,
  decrypt: (cipher) => (cipher.startsWith("enc:") ? cipher.slice(4) : null),
};
const sheet = {
  name: "Wren of the Ford",
  race: "human",
  class: "fighter",
  abilities: { str: 14, dex: 12, con: 13, int: 10, wis: 11, cha: 8 },
  maxHp: 12,
  ac: 16,
  hitDice: { die: "d10", total: 1, spent: 0 },
  proficiencies: { saves: ["str", "con"], skills: [], languages: [], tools: [], armor: [], weapons: [] },
};
const noLocal = () => ({
  state: "unavailable",
  origin: "",
  firstRun: false,
  hasAccount: false,
  username: "",
  serverVersion: "",
  error: "",
  lanOrigin: "",
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odm-relocate-"));
cleanup.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
const worldDir = path.join(tmp, "world");
fs.mkdirSync(worldDir);
const dbKey = randomBytes(32).toString("hex");
const hostStore = new ServerStore(path.join(tmp, "host-servers.json"), crypt);
const playerStore = new ServerStore(path.join(tmp, "player-servers.json"), crypt);

try {
  // ---- session one: the host shares, the friend joins by code ----
  const first = await bootWorld(worldDir, dbKey);
  const hostGrant = await registerAccount(first.origin, {
    username: "host",
    password: "host-pass-123",
    inviteCode: "",
  });
  const created = await json(first.origin, "/api/campaigns", hostGrant.token, {
    method: "POST",
    body: JSON.stringify({ title: "The Hollow Crown" }),
  });
  assert(created.status === 201, `campaign create returned ${created.status}`);
  const campaign = created.body.campaign;
  const code = campaign.inviteCode;
  ok(`world up at ${first.origin}, campaign ${campaign.id} has room code ${code}`);

  // syncPublicUrl's registry half: the owner's codes follow the address up.
  const owned = await ownedTableCodes(first.origin, hostGrant.token);
  assert(owned.includes(code), "the host's own campaign code is not among the owned codes");
  const published = await publishTables({
    codes: owned,
    url: first.origin,
    secretFor: (c) => hostStore.tableSecret(c),
  });
  assert(published.includes(code), "publishing the room code failed");
  ok("host published the room code at the first address");

  // The friend types the code. servers:open-invite asks the registry first.
  const found = await resolveTable(code.toLowerCase());
  assert(found === first.origin, `registry resolved ${JSON.stringify(found)}, wanted ${first.origin}`);
  const probe = await probeServer(found);
  assert(probe.deviceWorld === true, "the world does not report deviceWorld");
  assert(probe.signupMode === "open", `a device world reports signups ${probe.signupMode}`);
  assert(probe.instanceId, "the world exposes no instanceId");
  // join-form: a name and nothing else; the app mints the password.
  const minted = randomBytes(24).toString("base64url");
  const friend = await registerAccount(found, {
    username: "wren",
    password: minted,
    inviteCode: "",
    joinCode: code,
  });
  const entry = playerStore.upsert({
    origin: found,
    name: probe.serverName,
    username: friend.username,
    token: friend.token,
    tokenExpiresAt: friend.expiresAt,
    instanceId: probe.instanceId,
    secret: minted,
  });
  const joined = await json(found, "/api/campaigns/join", friend.token, {
    method: "POST",
    body: JSON.stringify({ inviteCode: code }),
  });
  assert(joined.status === 200, `join returned ${joined.status}: ${JSON.stringify(joined.body)}`);
  const made = await json(found, `/api/campaigns/${campaign.id}/sheet`, friend.token, {
    method: "POST",
    body: JSON.stringify(sheet),
  });
  assert(made.status === 201, `character create returned ${made.status}: ${JSON.stringify(made.body)}`);
  ok(`friend joined by code with a name only and made ${sheet.name}`);

  // The code the friend arrived with is kept on the entry itself, as
  // attachRemote does, so the world can be found again even if the home
  // screen never draws this host while it is up (a player who joins and
  // goes straight into the game, then closes the app).
  playerStore.rememberJoinCode(entry.id, code);
  assert(
    playerStore.tableCodesFor(entry.id).includes(code),
    "the join code was not kept on the entry",
  );
  ok("the room code the friend joined with is kept on the entry, before any home screen visit");

  // The home screen ran at least once while connected: that is where the
  // shell also learns which codes belong to this host.
  const relocateHost = async (input) => {
    const saved = playerStore.get(input.id);
    if (!saved) return "";
    const result = await relocateWorld(
      { origin: saved.origin, instanceId: saved.instanceId ?? "", codes: playerStore.tableCodesFor(saved.id) },
      { probe: (o) => probeServer(o).catch(() => null), resolveTable },
    );
    if (!result.found || !result.moved) return "";
    playerStore.rebindOrigin(saved.id, result.origin);
    return result.origin;
  };
  const feed = createDesktopHomeFeed({
    store: playerStore,
    localStatus: noLocal,
    emit: () => undefined,
    relocate: relocateHost,
  });
  await feed.refresh();
  assert(
    playerStore.tableCodesFor(entry.id).includes(code),
    "the home cache did not record the room code for this host",
  );
  ok("home feed cached the campaign and its room code");

  // ---- the host closes the world ----
  await dropTables({ codes: published, secretFor: (c) => hostStore.tableSecret(c) });
  await first.stop();
  assert((await resolveTable(code)) === "", "the registry still points at a closed world");
  ok("host stopped sharing: the code resolves nowhere, the old address is dead");

  // ---- session two: the same world, a brand new address ----
  const second = await bootWorld(worldDir, dbKey);
  assert(second.origin !== first.origin, "the second boot reused the first address");
  const probe2 = await probeServer(second.origin);
  assert(probe2.instanceId === probe.instanceId, "instanceId changed across the restart");
  const hostAgain = hostStore.tableSecret(code);
  const republished = await publishTables({
    codes: await ownedTableCodes(second.origin, (await loginForToken(second.origin, "host", "host-pass-123")).token),
    url: second.origin,
    secretFor: () => hostAgain,
  });
  assert(republished.includes(code), "re-pointing the code with the kept secret was refused");
  const squatter = await fetch(`${process.env.ODM_BROKER_URL}/table/${code}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-table-secret": "not-the-hosts-secret-at-all" },
    body: JSON.stringify({ url: "https://evil.example" }),
  });
  assert(squatter.status === 409, `another secret could move the code (${squatter.status})`);
  ok(`world back at ${second.origin} with the same instanceId; code re-pointed, squatter refused`);

  // ---- the friend comes back: connectRemote's sequence, step for step ----
  let saved = playerStore.get(entry.id);
  let token = playerStore.token(entry.id);
  assert(token, "the saved token is gone");
  assert(!(await tokenIsValid(saved.origin, token)), "the dead address still validates the token?");
  const located = await relocateWorld(
    { origin: saved.origin, instanceId: saved.instanceId ?? "", codes: playerStore.tableCodesFor(entry.id) },
    { probe: (o) => probeServer(o).catch(() => null), resolveTable },
  );
  assert(located.found && located.moved, `relocate answered ${JSON.stringify(located)}`);
  assert(located.origin === second.origin, `relocate chose ${located.origin}`);
  saved = playerStore.rebindOrigin(entry.id, located.origin);
  assert(saved.id === entry.id && saved.username === "wren", "the entry lost its id or account");
  assert(await tokenIsValid(saved.origin, token), "the saved session is not accepted at the new address");
  const me = await json(saved.origin, "/api/auth/me", token);
  assert(me.body?.user?.username === "wren", "signed in as somebody else");
  const list = await json(saved.origin, "/api/campaigns", token);
  assert(
    list.body.campaigns.some((c) => c.id === campaign.id),
    "the campaign is missing from the friend's list at the new address",
  );
  const mine = await json(saved.origin, `/api/campaigns/${campaign.id}/sheet`, token);
  assert(mine.status === 200 && mine.body?.sheet?.name === sheet.name, "the character did not come back");
  ok("friend is back in as the same account with the same character, no sign-in, no second account");

  // The home screen's half: the tile must not be drawn offline (and so not
  // tappable) when the world is merely elsewhere. Reset the entry to the
  // dead address to make the feed do the finding.
  playerStore.rebindOrigin(entry.id, first.origin);
  const home = await feed.refresh();
  const tile = home.hosts.find((h) => h.id === entry.id);
  assert(tile && tile.status === "online", `home feed drew the host as ${tile?.status}`);
  assert(playerStore.get(entry.id).origin === second.origin, "the feed did not move the entry");
  ok("home feed found the moved world and drew it online");

  // Expired session at the new address: the app-minted password renews it.
  playerStore.upsert({
    id: entry.id,
    origin: second.origin,
    name: saved.name,
    username: "wren",
    token,
    tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  assert(playerStore.token(entry.id) === null, "an expired token is still handed out");
  const secret = playerStore.secret(entry.id);
  assert(secret === minted, "the minted password did not survive the token refresh");
  const renewed = await loginForToken(second.origin, "wren", secret);
  assert(renewed.username === "wren", "renewal signed in as somebody else");
  ok("an expired session renews with the app-minted password, no form");

  // ---- the safety rule: a recycled address that answers as another world ----
  const strangerDir = path.join(tmp, "stranger");
  fs.mkdirSync(strangerDir);
  const stranger = await bootWorld(strangerDir, randomBytes(32).toString("hex"));
  await second.stop();
  tables.set(code, { url: stranger.origin, secret: hostAgain });
  const refused = await relocateWorld(
    { origin: second.origin, instanceId: probe.instanceId, codes: [code] },
    { probe: (o) => probeServer(o).catch(() => null), resolveTable },
  );
  assert(refused.found === false, `a stranger's world was adopted: ${JSON.stringify(refused)}`);
  await stranger.stop();
  ok("a different world at the code's address is refused, the session never follows it");

  console.log("RELOCATE SMOKE PASS");
} finally {
  for (const fn of cleanup.splice(0)) {
    try {
      fn();
    } catch {
      // Best effort on the way out.
    }
  }
}
