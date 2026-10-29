import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const nativeRequire = createRequire(import.meta.url);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function setupShutdown({ argv = [] } = {}) {
  const share = deferred();
  const ai = deferred();
  const local = deferred();
  const app = new EventEmitter();
  let localStops = 0;
  let aiStops = 0;
  let shareStops = 0;
  let completedQuits = 0;
  const timers = [];
  const startup = [];
  app.setName = (name) => void startup.push(`name:${name}`);
  app.requestSingleInstanceLock = () => {
    startup.push("lock");
    return true;
  };
  app.setPath = () => {};
  app.getPath = () => "C:\\unused-odm-test";
  app.getAppPath = () => "C:\\unused-odm-test";
  app.getVersion = () => "0.17.4";
  app.setAsDefaultProtocolClient = () => {};
  app.whenReady = () => Promise.resolve();
  app.isPackaged = false;
  app.quit = () => {
    let prevented = false;
    app.emit("before-quit", { preventDefault() { prevented = true; } });
    if (!prevented) completedQuits++;
  };

  const dependencies = {
    // A run whose safeStorage cannot seal has nothing to seal again.
    electron: { app, safeStorage: { isEncryptionAvailable: () => false }, shell: {}, session: { defaultSession: {} } },
    // The helper that opens what 0.22.0 sealed (src/main/renamed-key.ts).
    "./renamed-key": {
      ...nativeRequire("../dist/main/renamed-key.js"),
      runUnsealHelper: () => void startup.push("unseal"),
      recoverRenamedSeals: async () => 0,
    },
    // The shell's pages are isolated at start (src/main/isolation.ts): nothing to do here.
    "./isolation": { isolateShellPages: () => {} },
    "../shared/deck": { detectDeck: () => ({ gameMode: false, active: false, device: false }), steamLaunched: () => false },
    "../shared/deep-link": { joinLinkFromArgv: () => null },
    "./app-names": { APP_ID: "com.opengamemaster.client", LEGACY_APP_ID: "com.opendungeonmaster.client" },
    "./steam-shortcut": { repointRenamedShortcut: async () => null },
    "./steam-host": { systemSteamHost: () => ({}) },
    "./local-ai/manager": { LocalAiManager: class { stop() { aiStops++; return ai.promise; } } },
    "./local-server": { LocalServer: class { stop() { localStops++; return local.promise; } } },
    // A reset the previous run asked for (src/main/reset.ts): none here.
    "./reset": { applyPendingReset: async () => null },
    "./ipc": { registerIpc: () => ({ shutdownShare() { shareStops++; return share.promise; } }) },
    "./servers": { LOCAL_SERVER_ID: "local", ServerStore: class { storyMemory() { return ""; } deckChoice() { return ""; } } },
    "../shared/story-memory": { storyMemorySupported: () => false },
    "./tunnel": { QuickTunnel: class {} },
    "./edit-menu": { wireContextMenus: () => {} },
    "./updater": {
      detectInstallKind: () => "test",
      packageFormatOf: () => "",
      Updater: class { checkOnStartup() {} },
    },
    "./window": { ShellWindow: class {
      create() {}
      onSessionRevoked() {}
      whenPageReady() { return Promise.resolve(); }
    } },
  };
  const source = fs.readFileSync(new URL("../dist/main/index.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    exports: {},
    require: (id) => dependencies[id] ?? nativeRequire(id),
    process: { ...process, argv, env: {}, defaultApp: false },
    __dirname: path.dirname(new URL("../dist/main/index.js", import.meta.url).pathname),
    Buffer,
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
    clearTimeout: () => {},
  });
  await new Promise(setImmediate);
  return {
    app, share, ai, local, timers, startup,
    get shareStops() { return shareStops; },
    get aiStops() { return aiStops; },
    get localStops() { return localStops; },
    get completedQuits() { return completedQuits; },
  };
}

// safeStorage keys every saved sign-in under the app's name. Every release
// before 0.22.0 ran as the package's name (the packaged package.json has no
// productName), and that name must be set before anything (the instance
// lock, the keychain) reads it (client issue 100).
test("the app keeps its keychain name and sets it before anything reads it", async () => {
  const state = await setupShutdown();
  assert.deepEqual(state.startup.slice(0, 2), ["name:open-dungeon-master-client", "lock"]);
});

// The helper started to open what 0.22.0 sealed takes that release's name
// itself, and is no second copy of the app: no instance lock, no window.
test("the unseal helper runs instead of the app", async () => {
  const state = await setupShutdown({ argv: ["electron", "--unseal-renamed-key=/tmp/odm-unseal-test"] });
  assert.deepEqual(state.startup, ["unseal"]);
});

test("healthy quit keeps local server available until share cleanup finishes", async () => {
  const state = await setupShutdown();
  state.app.quit();
  await Promise.resolve();
  assert.equal(state.shareStops, 1);
  assert.equal(state.aiStops, 1);
  assert.equal(state.localStops, 0, "sharing still needs the local server");
  assert.equal(state.completedQuits, 0);

  state.share.resolve();
  await new Promise(setImmediate);
  assert.equal(state.localStops, 1, "local stop starts as soon as sharing is cleaned up");
  assert.equal(state.completedQuits, 0);

  state.ai.resolve();
  state.local.resolve();
  await new Promise(setImmediate);
  assert.equal(state.completedQuits, 1);
  assert.equal(state.timers.length, 1);
  assert.equal(state.timers[0].ms, 3000);
});

test("hung sharing still initiates local stop by one total deadline", async () => {
  const state = await setupShutdown();
  state.app.quit();
  await Promise.resolve();
  assert.equal(state.shareStops, 1);
  assert.equal(state.aiStops, 1);
  assert.equal(state.localStops, 0);
  assert.equal(state.completedQuits, 0);

  state.app.quit();
  state.app.emit("window-all-closed");
  await Promise.resolve();
  assert.equal(state.completedQuits, 0, "a second quit event must wait for the same shutdown");
  assert.equal(state.timers.length, 1);
  assert.equal(state.timers[0].ms, 3000);

  state.timers[0].callback();
  await new Promise(setImmediate);
  assert.equal(state.localStops, 1, "the timeout must initiate local stop despite hung sharing");
  assert.equal(state.completedQuits, 1);
  assert.equal(state.shareStops, 1);
  assert.equal(state.aiStops, 1);
});
