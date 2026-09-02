import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLocalWorld,
  type LocalProfile,
  type LocalWorldDeps,
  type WorldStatus,
} from "../src/local-world";

// The phone-hosted world's account flow, against a fake plugin and API.

function harness(overrides: {
  world?: Partial<WorldStatus>;
  profile?: LocalProfile | null;
  tokenValid?: boolean;
  loginFails?: boolean;
} = {}) {
  const world: WorldStatus = {
    available: true,
    state: "stopped",
    origin: "",
    lanOrigin: "",
    firstRun: true,
    serverVersion: "0.12.1",
    error: "",
    ...overrides.world,
  };
  let profile: LocalProfile | null = overrides.profile ?? null;
  const calls: string[] = [];
  const opened: string[] = [];
  const patches: object[] = [];
  const deps: LocalWorldDeps = {
    plugin: {
      status: async () => ({ ...world }),
      start: async () => {
        calls.push("start");
        world.state = "running";
        world.origin = "http://127.0.0.1:3210";
        world.lanOrigin = "http://192.168.1.9:3210";
        return { ...world };
      },
      stop: async () => {
        world.state = "stopped";
        world.origin = "";
        return { ...world };
      },
      log: async () => ({ text: "" }),
    },
    loadProfile: async () => profile,
    saveProfile: async (next) => {
      profile = next;
    },
    loginForToken: async (_origin, username, password) => {
      calls.push(`login:${username}:${password}`);
      if (overrides.loginFails) throw new Error("Wrong username or password.");
      return { token: "tok-relogin", expiresAt: "2030-01-01T00:00:00.000Z", username };
    },
    registerAccount: async (_origin, input) => {
      calls.push(`register:${input.username}:${input.password}`);
      return { token: "tok-new", expiresAt: "2030-01-01T00:00:00.000Z", username: input.username };
    },
    tokenIsValid: async () => overrides.tokenValid ?? false,
    patchAdminSettings: async (_origin, _token, patch) => {
      patches.push(patch);
    },
    open: async (origin, token, joinCode) => {
      opened.push(`${origin}|${token}|${joinCode}`);
    },
    emit: () => undefined,
    randomSecret: () => "minted-secret",
  };
  return { deps, calls, opened, patches, profile: () => profile, world };
}

test("a fresh world starts the server and asks for a name", async () => {
  const h = harness();
  const result = await createLocalWorld(h.deps).play("");
  assert.deepEqual(result, { ok: true, firstSetup: true, needsName: true });
  assert.deepEqual(h.calls, ["start"]);
  assert.equal(h.opened.length, 0);
});

test("a name-only profile mints and keeps a secret, then plays with it", async () => {
  const h = harness({ tokenValid: true });
  const world = createLocalWorld(h.deps);
  const created = await world.createAccount({ username: "kaleb", password: "" });
  assert.equal(created.ok, true);
  assert.equal(h.profile()?.secret, "minted-secret");
  assert.equal(h.calls.at(-1), "register:kaleb:minted-secret");
  // Mesh voice and the Wi-Fi address were written to the world's settings.
  assert.deepEqual(h.patches.at(-1), {
    voiceChat: { enabled: "on", mode: "mesh" },
    publicUrl: "http://192.168.1.9:3210",
  });
  h.world.firstRun = false;
  const played = await world.play("ABCDEF");
  assert.deepEqual(played, { ok: true });
  assert.equal(h.opened.at(-1), "http://127.0.0.1:3210|tok-new|ABCDEF");
});

test("a chosen password is never kept", async () => {
  const h = harness();
  await createLocalWorld(h.deps).createAccount({ username: "kaleb", password: "hunter2" });
  assert.equal(h.profile()?.secret, "");
  assert.equal(h.calls.at(-1), "register:kaleb:hunter2");
});

test("an expired token renews silently from the kept secret", async () => {
  const h = harness({
    world: { firstRun: false },
    profile: { username: "kaleb", secret: "s3cret", token: "old", tokenExpiresAt: "2000-01-01T00:00:00.000Z" },
  });
  const result = await createLocalWorld(h.deps).play("");
  assert.deepEqual(result, { ok: true });
  assert.ok(h.calls.includes("login:kaleb:s3cret"));
  assert.equal(h.profile()?.token, "tok-relogin");
  assert.equal(h.opened.at(-1), "http://127.0.0.1:3210|tok-relogin|");
});

test("a dead token with no secret asks for a sign-in on an existing world", async () => {
  const h = harness({
    world: { firstRun: false },
    profile: { username: "kaleb", secret: "", token: "old", tokenExpiresAt: "2000-01-01T00:00:00.000Z" },
  });
  const result = await createLocalWorld(h.deps).play("");
  assert.deepEqual(result, { ok: false, needsLogin: true, error: "Sign in to your world." });
});

test("a rejected secret falls back to the sign-in form", async () => {
  const h = harness({
    world: { firstRun: false },
    profile: { username: "kaleb", secret: "stale", token: "", tokenExpiresAt: "" },
    loginFails: true,
  });
  const result = await createLocalWorld(h.deps).play("");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.needsLogin, true);
});

test("status reports the world and the profile together", async () => {
  const h = harness({
    world: { state: "running", origin: "http://127.0.0.1:3210", lanOrigin: "http://192.168.1.9:3210", firstRun: false },
    profile: { username: "kaleb", secret: "", token: "t", tokenExpiresAt: "2030-01-01T00:00:00.000Z" },
  });
  const status = await createLocalWorld(h.deps).status();
  assert.equal(status.state, "running");
  assert.equal(status.username, "kaleb");
  assert.equal(status.hasAccount, true);
  assert.equal(status.lanOrigin, "http://192.168.1.9:3210");
});

test("a build without a runtime reports the world as unavailable", async () => {
  const h = harness({ world: { available: false } });
  const status = await createLocalWorld(h.deps).status();
  assert.equal(status.state, "unavailable");
});
