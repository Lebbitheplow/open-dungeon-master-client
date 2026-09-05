import { App } from "@capacitor/app";
import { BleClient } from "@capacitor-community/bluetooth-le";
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from "@capacitor/barcode-scanner";
import { CapacitorCookies, CapacitorHttp } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Preferences } from "@capacitor/preferences";
import { Share } from "@capacitor/share";
import { BackgroundColor, InAppBrowser, ToolBarType } from "@capgo/inappbrowser";
import { createBleRelay } from "./ble-relay";
import { createDownloadRelay } from "./download-relay";
import { createAndroidHomeFeed } from "./home-feed";
import {
  createLocalWorld,
  LocalWorld,
  tokenAlive as profileTokenAlive,
  type LocalProfile,
} from "./local-world";
import { createShareTunnel, type JsonReply, type SharePlugin } from "./share-tunnel";
import {
  CODE_SHAPE,
  normalizeOrigin,
  originCandidates,
  parseAnyLink,
  type JoinLink,
} from "../../src/shared/deep-link";
import { landingPath, safeInnerPath } from "../../src/shared/open-path";
import type {
  AccountDeletionResult,
  ConnectResult,
  OdmBridge,
  ShellShareStatus,
  Result,
  ServerProbe,
  ServerSummary,
  ShellEvent,
  SignupMode,
} from "../../src/shared/types";

// The Android implementation of the window.odm bridge. Same shared manager
// UI as the desktop shell; here the privileged side is Capacitor. Server
// pages open in a separate native WebView (no Capacitor bridge injected),
// logged in by planting the odm_session cookie in the shared CookieManager.
// The device hosts its own world too (local-world.ts) and can share it on
// the internet through a tunnel (share-tunnel.ts), like the desktop shell.

interface StoredServer {
  id: string;
  origin: string;
  name: string;
  username: string;
  lastUsedAt: string;
  // Stored in app-private Preferences. Android sandboxes this per app;
  // moving tokens into a Keystore-backed store is a planned hardening step.
  token: string;
  tokenExpiresAt: string;
  // The world's stable id from /api/auth/providers ("" or absent on servers
  // that predate it). Lets the shell recognize a device world that came back
  // at a new tunnel address and move this entry there instead of adding a
  // duplicate.
  instanceId?: string;
}

const SERVERS_KEY = "odm-servers";
const TIMEOUT_MS = 10_000;

// ---------- storage ----------

async function loadServers(): Promise<StoredServer[]> {
  try {
    const { value } = await Preferences.get({ key: SERVERS_KEY });
    const parsed = value ? (JSON.parse(value) as StoredServer[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveServers(servers: StoredServer[]): Promise<void> {
  await Preferences.set({ key: SERVERS_KEY, value: JSON.stringify(servers) });
}

function summaryOf(server: StoredServer): ServerSummary {
  return {
    id: server.id,
    origin: server.origin,
    name: server.name,
    username: server.username,
    lastUsedAt: server.lastUsedAt,
    hasToken: tokenAlive(server),
  };
}

function tokenAlive(server: StoredServer): boolean {
  if (!server.token) return false;
  return !server.tokenExpiresAt || Date.parse(server.tokenExpiresAt) > Date.now();
}

// ---------- HTTP (native, so plain-http LAN servers and no CORS walls) ----------

interface HttpReply {
  status: number;
  data: unknown;
}

async function http(
  origin: string,
  pathname: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<HttpReply> {
  try {
    const response = await CapacitorHttp.request({
      url: `${origin}${pathname}`,
      method: init.method ?? "GET",
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      data: init.body,
      connectTimeout: TIMEOUT_MS,
      readTimeout: TIMEOUT_MS,
    });
    return { status: response.status, data: response.data };
  } catch {
    throw new Error(`Could not reach ${origin}. Check the address and your connection.`);
  }
}

function errorText(reply: HttpReply, fallback: string): string {
  const data = reply.data as { error?: string } | null;
  return (data && typeof data.error === "string" && data.error) || fallback;
}

async function probeOrigin(origin: string): Promise<ServerProbe> {
  const reply = await http(origin, "/api/auth/providers");
  const body = reply.data as {
    discord?: boolean;
    password?: boolean;
    signupMode?: string;
    serverName?: string;
    version?: string;
    instanceId?: string;
  } | null;
  if (reply.status !== 200 || !body || typeof body.password !== "boolean") {
    throw new Error(`${origin} does not look like an Open Dungeon Master server.`);
  }
  const signupMode: SignupMode =
    body.signupMode === "invite" || body.signupMode === "closed" ? body.signupMode : "open";
  return {
    origin,
    serverName: typeof body.serverName === "string" ? body.serverName : "",
    version: typeof body.version === "string" ? body.version : "",
    signupMode,
    discord: Boolean(body.discord),
    instanceId: typeof body.instanceId === "string" ? body.instanceId : "",
  };
}

interface TokenGrant {
  token: string;
  expiresAt: string;
  username: string;
}

async function loginForToken(
  origin: string,
  username: string,
  password: string,
): Promise<TokenGrant> {
  const reply = await http(origin, "/api/auth/token", {
    method: "POST",
    body: { username, password },
  });
  if (reply.status !== 200) throw new Error(errorText(reply, "Sign-in failed."));
  const body = reply.data as { token: string; expiresAt: string; user: { username: string } };
  return { token: body.token, expiresAt: body.expiresAt, username: body.user.username };
}

async function registerAccount(
  origin: string,
  input: { username: string; password: string; inviteCode: string },
): Promise<TokenGrant> {
  const body: Record<string, string> = { username: input.username, password: input.password };
  if (input.inviteCode) body.inviteCode = input.inviteCode;
  const reply = await http(origin, "/api/auth/register", { method: "POST", body });
  if (reply.status !== 201) throw new Error(errorText(reply, "Could not create the account."));
  return loginForToken(origin, input.username, input.password);
}

// Self-service account deletion (DELETE /api/profile). Password accounts
// must send their password; Discord-only accounts send "".
async function deleteAccount(
  origin: string,
  token: string,
  password: string,
): Promise<AccountDeletionResult> {
  const reply = await http(origin, "/api/profile", {
    method: "DELETE",
    token,
    body: password ? { password } : {},
  });
  if (reply.status !== 200) throw new Error(errorText(reply, "Could not delete the account."));
  const body = reply.data as { dueAt?: string; graceDays?: number; purged?: boolean } | null;
  return {
    dueAt: typeof body?.dueAt === "string" ? body.dueAt : "",
    graceDays: typeof body?.graceDays === "number" ? body.graceDays : 0,
    purged: body?.purged === true,
  };
}

async function tokenIsValid(origin: string, token: string): Promise<boolean> {
  try {
    return (await http(origin, "/api/auth/me", { token })).status === 200;
  } catch {
    return false;
  }
}

async function patchAdminSettings(origin: string, token: string, patch: object): Promise<void> {
  const reply = await http(origin, "/api/admin/settings", { method: "PATCH", token, body: patch });
  if (reply.status !== 200) throw new Error(errorText(reply, "Saving world settings failed."));
}

// ---------- events and the server webview ----------

const listeners = new Set<(event: ShellEvent) => void>();

function emit(event: ShellEvent): void {
  for (const listener of listeners) listener(event);
}

// Android 13+ only shows notifications after a runtime POST_NOTIFICATIONS
// grant, and connecting is the first moment they mean anything (session
// reminders, turn alerts). Asked once per run; the system remembers a grant
// or denial, so repeat connects never nag. Scaffolding only for now: server
// pages run in the InAppBrowser webview, which does not grant the web
// Notification API, so a follow-up must either enable notifications on that
// webview (WebChromeClient permission grant in @capgo/inappbrowser) or
// listen to the server's event stream natively and post through
// LocalNotifications.schedule.
let notificationsAsked = false;

async function ensureNotificationPermission(): Promise<void> {
  if (notificationsAsked) return;
  notificationsAsked = true;
  try {
    const status = await LocalNotifications.checkPermissions();
    if (status.display === "prompt" || status.display === "prompt-with-rationale") {
      await LocalNotifications.requestPermissions();
    }
  } catch {
    // A missing or denied permission must never block connecting.
  }
}

// ---------- Bluetooth dice (Web Bluetooth bridge for the game webview) ----------

// The game pairs Pixels dice via navigator.bluetooth, which the Android
// WebView lacks. A polyfill (built to www/ble-polyfill.js) is injected into
// every server page before its scripts run; it relays GATT calls here over
// the InAppBrowser message channel and this relay runs them natively.
const GRANTED_DICE_KEY = "odm-ble-granted";

const bleRelay = createBleRelay({
  ble: BleClient,
  send: (detail) => void InAppBrowser.postMessage({ detail }).catch(() => undefined),
  async loadGranted() {
    try {
      const { value } = await Preferences.get({ key: GRANTED_DICE_KEY });
      const parsed = value ? (JSON.parse(value) as string[]) : [];
      return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
    } catch {
      return [];
    }
  },
  async saveGranted(ids) {
    await Preferences.set({ key: GRANTED_DICE_KEY, value: JSON.stringify(ids) });
  },
});

// ---------- file exports (download bridge for the game webview) ----------
// The game webview has no download handler, so an <a download> click there
// (character-sheet PDF, workshop bundle, story export) would do nothing. A
// shim (built to www/download-shim.js) injected next to the BLE polyfill
// fetches the file inside the page and posts its bytes here; the relay parks
// them in the app cache and opens the system share sheet, where the player
// saves to Files or Drive or sends the file on. The cache folder is covered
// by the FileProvider the app manifest already declares (res/xml/file_paths).
const downloadRelay = createDownloadRelay({
  async writeCache(path, data) {
    const written = await Filesystem.writeFile({
      path,
      data,
      directory: Directory.Cache,
      recursive: true,
    });
    return written.uri;
  },
  async clearCache(path) {
    await Filesystem.rmdir({ path, directory: Directory.Cache, recursive: true });
  },
  async share(title, uri) {
    await Share.share({ title, files: [uri] });
  },
  // The manager UI sits hidden under the game webview, so the message goes
  // back down to the page, where the shim renders it as a toast.
  notify(message) {
    void InAppBrowser.postMessage({
      detail: { type: "odm-download-notice", message },
    }).catch(() => undefined);
  },
});

// The manager UI ships the game-page scripts as sibling assets. Each is a
// self-contained IIFE, so they concatenate into one preShowScript; a missing
// or failing one must never block connecting, it only disables its feature
// (dice pairing, file exports, the account menu's way back to this list).
const INJECTED_SCRIPTS = ["ble-polyfill.js", "download-shim.js", "shell-hook.js"];

// The game's own night background, painted behind the status bar and the
// navigation bar so the page and the system chrome read as one surface.
const NIGHT = "#0a0817";
let injectedScripts: Promise<string> | null = null;
function loadInjectedScripts(): Promise<string> {
  injectedScripts ??= Promise.all(
    INJECTED_SCRIPTS.map((name) =>
      fetch(name)
        .then((response) => (response.ok ? response.text() : ""))
        .catch(() => ""),
    ),
  ).then((parts) => parts.filter((part) => part.length > 0).join("\n;\n"));
  return injectedScripts;
}

// No toolbar: the page is the app. The status bar and navigation bar keep
// their space (the WebView cannot see them itself), the hardware back
// button walks the page's own history, and at its root it closes the
// page, landing here. The page's account menu offers the same door.
async function openGameWebView(url: string, title: string): Promise<void> {
  const preShowScript = await loadInjectedScripts();
  await InAppBrowser.openWebView({
    url,
    toolbarType: ToolBarType.BLANK,
    toolbarColor: NIGHT,
    backgroundColor: BackgroundColor.BLACK,
    enabledSafeBottomMargin: true,
    activeNativeNavigationForWebview: true,
    title,
    // documentStart injection needs the present-after-load mode; the game's
    // Bluetooth feature detection must run after the polyfill exists.
    ...(preShowScript
      ? {
          isPresentAfterPageLoad: true,
          preShowScript,
          preShowScriptInjectionTime: "documentStart" as const,
        }
      : {}),
  });
  // The system dialog renders above the webview, so asking after the open
  // never delays the connect itself.
  void ensureNotificationPermission();
}

async function openServer(server: StoredServer, joinCode: string, path = ""): Promise<void> {
  await CapacitorCookies.setCookie({
    url: server.origin,
    key: "odm_session",
    value: server.token,
  });
  worldPageOpen = false;
  await openGameWebView(`${server.origin}${landingPath(joinCode, path)}`, server.name);
}

// ---------- the device-hosted world ----------

// The on-device profile lives beside the server list in app-private
// Preferences; the world's data itself is the server's SQLite file in the
// app's files directory (WorldRuntime.java).
const LOCAL_PROFILE_KEY = "odm-local-profile";

function randomSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function loadLocalProfile(): Promise<LocalProfile | null> {
  try {
    const { value } = await Preferences.get({ key: LOCAL_PROFILE_KEY });
    const parsed = value ? (JSON.parse(value) as LocalProfile) : null;
    return parsed && typeof parsed.username === "string" ? parsed : null;
  } catch {
    return null;
  }
}

const localWorld = createLocalWorld({
  plugin: LocalWorld,
  loadProfile: loadLocalProfile,
  async saveProfile(profile) {
    if (profile) {
      await Preferences.set({ key: LOCAL_PROFILE_KEY, value: JSON.stringify(profile) });
    } else {
      await Preferences.remove({ key: LOCAL_PROFILE_KEY });
    }
  },
  loginForToken,
  registerAccount,
  tokenIsValid,
  patchAdminSettings,
  async open(origin, token, joinCode, path) {
    await CapacitorCookies.setCookie({ url: origin, key: "odm_session", value: token });
    worldPageOpen = true;
    await openGameWebView(`${origin}${landingPath(joinCode, path)}`, "This device");
  },
  emit,
  randomSecret,
  currentShareUrl: () => shareTunnel.snapshot().url,
});

// ---------- sharing the world on the internet ----------

// True while the game webview shows this device's own world; only then may
// a page's odmShell.share requests do anything.
let worldPageOpen = false;

// Native JSON round trip that reports bad statuses instead of throwing;
// only no reply at all rejects. Shared by the tunnel and the home feed.
async function fetchJson(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
): Promise<JsonReply> {
  const timeout = init.timeoutMs ?? TIMEOUT_MS;
  const response = await CapacitorHttp.request({
    url,
    method: init.method ?? "GET",
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    data: init.body,
    connectTimeout: timeout,
    readTimeout: timeout,
    responseType: "json",
  });
  let data: unknown = response.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      // Not JSON (a health page, an error body); the caller only needs the status then.
    }
  }
  return { status: response.status, data };
}

const shareTunnel = createShareTunnel({
  plugin: LocalWorld as unknown as SharePlugin,
  fetchJson,
  brokerUrl: () => "",
  async worldPort() {
    const origin = await localWorld.start();
    return Number(new URL(origin).port);
  },
  publish: (url) => localWorld.publish(url),
  emit,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
});

const SHARE_UNSUPPORTED: ShellShareStatus = {
  supported: false,
  state: "stopped",
  url: "",
  mode: "",
  error: "",
  lanUrl: "",
};

async function shellShareStatus(): Promise<ShellShareStatus> {
  if (!worldPageOpen) return SHARE_UNSUPPORTED;
  const [status, world] = await Promise.all([shareTunnel.status(), localWorld.status()]);
  return { supported: true, ...status, lanUrl: world.lanOrigin };
}

// Down to the game page's shell hook (shell-hook.ts): an answer to one
// request when id is given, otherwise a broadcast to its subscribers.
function pushShareStatus(id: number | undefined, status: ShellShareStatus): void {
  void InAppBrowser.postMessage({
    detail: { type: "odm-share-status", id, status },
  }).catch(() => undefined);
}

listeners.add((event) => {
  if (event.kind !== "tunnel-status" || !worldPageOpen) return;
  void localWorld.status().then((world) => {
    pushShareStatus(undefined, { supported: true, ...event.status, lanUrl: world.lanOrigin });
  });
});

// ---------- the home screen's campaign feed ----------

const homeFeed = createAndroidHomeFeed({
  async servers() {
    return (await loadServers()).map((server) => ({
      id: server.id,
      origin: server.origin,
      name: server.name,
      username: server.username,
      lastUsedAt: server.lastUsedAt,
      token: tokenAlive(server) ? server.token : "",
    }));
  },
  localStatus: () => localWorld.status(),
  async localToken() {
    const profile = await loadLocalProfile();
    return profileTokenAlive(profile) ? (profile?.token ?? "") : "";
  },
  fetchJson,
  getPref: async (key) => (await Preferences.get({ key })).value,
  setPref: async (key, value) => Preferences.set({ key, value }),
  emit,
});

// The world coming up or the tunnel changing are reasons to look again; the
// feed announces the outcome itself as a home-feed event.
listeners.add((event) => {
  if (event.kind === "local-status" || event.kind === "tunnel-status") {
    homeFeed.refresh().catch(() => undefined);
  }
});

// The lobby's invite dialog asks to share the world (or stop). A start is
// answered at once with the "starting" snapshot; the outcome reaches the
// page through the broadcast above, since a tunnel can take longer to come
// up than a page should wait on one request.
async function handleShareRequest(request: { action: string; id?: number }): Promise<void> {
  const id = typeof request.id === "number" ? request.id : undefined;
  if (!worldPageOpen) {
    pushShareStatus(id, SHARE_UNSUPPORTED);
    return;
  }
  if (request.action === "start") {
    void shareTunnel.start();
    pushShareStatus(id, { ...(await shellShareStatus()), state: "starting", error: "" });
    return;
  }
  if (request.action === "stop") {
    await shareTunnel.stop();
  }
  pushShareStatus(id, await shellShareStatus());
}

// ---------- Discord sign-in (the server's own OAuth, in the game webview) ----------

// The round trip starts on the server, visits discord.com and lands back on
// the server with the odm_session cookie set in the shared CookieManager.
// The webview stays open as the game; this side only harvests the session
// so the server list can remember the account like a password login.
const SESSION_COOKIE = "odm_session";
// The server's session TTL; the cookie's own expiry is not readable here.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface PendingDiscord {
  origin: string;
  joinCode: string;
  resolve: (result: Result<{ server: ServerSummary }>) => void;
}

let pendingDiscord: PendingDiscord | null = null;

function settleDiscord(result: Result<{ server: ServerSummary }>): void {
  const pending = pendingDiscord;
  pendingDiscord = null;
  pending?.resolve(result);
}

async function startDiscordLogin(
  origin: string,
  joinCode: string,
): Promise<Result<{ server: ServerSummary }>> {
  settleDiscord(fail(new Error("Sign-in was interrupted.")));
  // A stale session cookie would make the callback look like a fresh one.
  await CapacitorCookies.clearCookies({ url: origin }).catch(() => undefined);
  const next = joinCode ? `/join/${joinCode}` : "/";
  const start = `${origin}/api/auth/discord/start?next=${encodeURIComponent(next)}`;
  let name = "";
  try {
    name = (await probeOrigin(origin)).serverName;
  } catch {
    // Cosmetic; the start route will say if the server is not real.
  }
  return new Promise((resolve) => {
    pendingDiscord = { origin, joinCode, resolve };
    openGameWebView(start, name || new URL(origin).host).catch((err: unknown) => {
      settleDiscord(fail(err));
    });
  });
}

// Every navigation inside the game webview: while a Discord sign-in is
// pending, a return to the server's origin is the callback having finished,
// one way or the other.
async function onWebviewUrl(url: string): Promise<void> {
  const pending = pendingDiscord;
  if (!pending || !url.startsWith(`${pending.origin}/`) && url !== pending.origin) return;
  if (url.includes("/api/auth/discord/")) return;
  let failed = false;
  try {
    failed = new URL(url).searchParams.get("error") === "discord";
  } catch {
    return;
  }
  if (failed) {
    await InAppBrowser.close().catch(() => undefined);
    settleDiscord(fail(new Error("Discord sign-in failed. Try again.")));
    return;
  }
  const cookies = await InAppBrowser.getCookies({ url: pending.origin, includeHttpOnly: true }).catch(
    () => ({}) as Record<string, string>,
  );
  const token = cookies[SESSION_COOKIE];
  if (!token) return;
  try {
    const reply = await http(pending.origin, "/api/auth/me", { token });
    const body = reply.data as { user?: { username?: string } } | null;
    const username = body?.user?.username;
    if (reply.status !== 200 || typeof username !== "string") {
      throw new Error("The sign-in did not produce a usable session.");
    }
    const grant: TokenGrant = {
      token,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      username,
    };
    settleDiscord(await rememberGrant(pending.origin, grant));
  } catch (err) {
    await InAppBrowser.close().catch(() => undefined);
    settleDiscord(fail(err));
  }
}

async function connectById(id: string, joinCode: string, path = ""): Promise<ConnectResult> {
  const servers = await loadServers();
  const server = servers.find((entry) => entry.id === id);
  if (!server) return { ok: false, needsLogin: false, error: "Unknown server." };
  if (!tokenAlive(server) || !(await tokenIsValid(server.origin, server.token))) {
    return { ok: false, needsLogin: true, error: "Your session expired. Sign in again." };
  }
  server.lastUsedAt = new Date().toISOString();
  await saveServers(servers);
  // Best effort: learn the world's stable id, so entries saved before the
  // server exposed one can still be matched when a device world comes back
  // at a new tunnel address.
  if (!server.instanceId) {
    void probeOrigin(server.origin)
      .then(async (probe) => {
        if (!probe.instanceId) return;
        const latest = await loadServers();
        const entry = latest.find((item) => item.id === server.id);
        if (!entry || entry.instanceId === probe.instanceId) return;
        entry.instanceId = probe.instanceId;
        await saveServers(latest);
      })
      .catch(() => undefined);
  }
  await openServer(server, joinCode, path);
  return { ok: true };
}

// Writes a fresh session into the server list (new entry or refreshed
// token) without opening anything.
async function rememberGrant(
  origin: string,
  grant: TokenGrant,
): Promise<{ ok: true; server: ServerSummary; stored: StoredServer }> {
  let name = "";
  let instanceId = "";
  try {
    const probe = await probeOrigin(origin);
    name = probe.serverName;
    instanceId = probe.instanceId;
  } catch {
    // Cosmetic; the login already proved the server is real.
  }
  const servers = await loadServers();
  // Dedupe by origin first, then by the world's stable id: a device world
  // back at a new tunnel address refreshes its old entry instead of adding
  // a second one.
  const existing =
    servers.find((entry) => entry.origin === origin) ??
    (instanceId ? servers.find((entry) => entry.instanceId === instanceId) : undefined);
  const server: StoredServer = {
    id: existing?.id ?? crypto.randomUUID(),
    origin,
    name: name || new URL(origin).host,
    username: grant.username,
    lastUsedAt: new Date().toISOString(),
    token: grant.token,
    tokenExpiresAt: grant.expiresAt,
    instanceId: instanceId || existing?.instanceId,
  };
  if (existing) servers[servers.indexOf(existing)] = server;
  else servers.push(server);
  await saveServers(servers);
  return { ok: true, server: summaryOf(server), stored: server };
}

async function adoptGrant(
  origin: string,
  grant: TokenGrant,
  joinCode: string,
): Promise<Result<{ server: ServerSummary }>> {
  const remembered = await rememberGrant(origin, grant);
  await openServer(remembered.stored, joinCode);
  return { ok: true, server: remembered.server };
}

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : "Something went wrong." };
}

function cleanCode(value: unknown): string {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return CODE_SHAPE.test(code) ? code : "";
}

// ---------- deep links (odm:// and https://opendungeonmaster.com/j) ----------

async function handleJoinLink(link: JoinLink): Promise<void> {
  const servers = await loadServers();
  let known = servers.find((entry) => entry.origin === link.origin);
  if (!known) {
    // A device world gets a fresh tunnel hostname every share session. If
    // the server at the new address identifies as a world this app already
    // has an account on, move that entry to the new address and walk in
    // with the stored token instead of asking for a second login.
    try {
      const probe = await probeOrigin(link.origin);
      const match = probe.instanceId
        ? servers.find((entry) => entry.instanceId === probe.instanceId)
        : undefined;
      if (match) {
        match.origin = link.origin;
        match.lastUsedAt = new Date().toISOString();
        await saveServers(servers);
        known = match;
      }
    } catch {
      // Unreachable or not an ODM server; the add screen will say so.
    }
  }
  if (known) {
    const result = await connectById(known.id, link.code);
    if (result.ok) return;
  }
  emit({
    kind: "join-request",
    origin: link.origin,
    code: link.code,
    knownServerId: known?.id ?? "",
  });
}

async function handleLink(raw: string): Promise<void> {
  const link = parseAnyLink(raw);
  if (link) await handleJoinLink(link);
}

// ---------- the bridge ----------

const bridge: OdmBridge = {
  platform: "android",

  async listServers() {
    const servers = await loadServers();
    servers.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
    return {
      servers: servers.map(summaryOf),
      local: await localWorld.status(),
      tunnel: await shareTunnel.status(),
    };
  },

  async probeServer(raw: string) {
    let lastError: unknown = null;
    for (const origin of originCandidates(String(raw ?? ""))) {
      try {
        return { ok: true, probe: await probeOrigin(origin) };
      } catch (err) {
        lastError = err;
      }
    }
    return fail(lastError ?? new Error("That does not look like a server address."));
  },

  async login(input) {
    try {
      const origin = normalizeOrigin(String(input?.origin ?? ""));
      if (!origin) return fail(new Error("Bad server address."));
      const grant = await loginForToken(origin, String(input.username), String(input.password));
      return await adoptGrant(origin, grant, cleanCode(input.joinCode));
    } catch (err) {
      return fail(err);
    }
  },

  async register(input) {
    try {
      const origin = normalizeOrigin(String(input?.origin ?? ""));
      if (!origin) return fail(new Error("Bad server address."));
      const grant = await registerAccount(origin, {
        username: String(input.username),
        password: String(input.password),
        inviteCode: String(input.inviteCode ?? "").trim(),
      });
      return await adoptGrant(origin, grant, cleanCode(input.joinCode));
    } catch (err) {
      return fail(err);
    }
  },

  async discordLogin(input) {
    const origin = normalizeOrigin(String(input?.origin ?? ""));
    if (!origin) return fail(new Error("Bad server address."));
    return startDiscordLogin(origin, cleanCode(input.joinCode));
  },

  connect: (serverId, joinCode, path) =>
    connectById(String(serverId), cleanCode(joinCode), safeInnerPath(path)),

  // Back on the home screen: finish the activity, which is what Android
  // users expect from a root screen (the launcher, not a dead tap).
  leaveApp: () => App.exitApp(),

  async openInviteLink(raw) {
    const link = parseAnyLink(String(raw ?? ""));
    if (!link) return false;
    await handleJoinLink(link);
    return true;
  },

  // The in-app QR path for invite codes; the plugin owns the camera UI and
  // its runtime permission prompt.
  async scanInvite() {
    try {
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
      });
      const raw = String(result.ScanResult ?? "").trim();
      if (!raw) return { ok: true };
      const link = parseAnyLink(raw);
      if (!link) {
        return { ok: false, error: "That QR code is not an Open Dungeon Master invite." };
      }
      await handleJoinLink(link);
      return { ok: true };
    } catch (err) {
      // Backing out of the scanner is not an error worth showing.
      const message = err instanceof Error ? err.message : "";
      if (/cancel/i.test(message)) return { ok: true };
      return fail(err);
    }
  },

  // Mirrors the desktop handler: the session goes, the entry stays so a
  // sign-in before the due date can still keep the account.
  async deleteAccount(input) {
    const serverId = String(input?.serverId ?? "");
    const servers = await loadServers();
    const server = servers.find((entry) => entry.id === serverId);
    if (!server || !tokenAlive(server)) {
      return fail(new Error("Sign in to this server first, then delete the account."));
    }
    try {
      const deletion = await deleteAccount(server.origin, server.token, String(input?.password ?? ""));
      server.token = "";
      server.tokenExpiresAt = "";
      await saveServers(servers);
      await CapacitorCookies.clearCookies({ url: server.origin }).catch(() => undefined);
      return { ok: true, deletion };
    } catch (err) {
      return fail(err);
    }
  },

  async removeServer(serverId) {
    const servers = await loadServers();
    const server = servers.find((entry) => entry.id === serverId);
    await saveServers(servers.filter((entry) => entry.id !== serverId));
    if (server) {
      await CapacitorCookies.clearCookies({ url: server.origin }).catch(() => undefined);
    }
  },

  homeFeed: () => homeFeed.refresh(),
  homeFeedCached: () => homeFeed.cached(),

  async localStart() {
    try {
      await localWorld.start();
      return { ok: true, status: await localWorld.status() };
    } catch (err) {
      return fail(err);
    }
  },
  localCreateAccount: (input) =>
    localWorld.createAccount({
      username: String(input?.username ?? "").trim(),
      password: String(input?.password ?? ""),
    }),
  localLogin: (input) =>
    localWorld.login({
      username: String(input?.username ?? "").trim(),
      password: String(input?.password ?? ""),
    }),
  localConfigureAi: (setup) => localWorld.configureAi(setup),
  localPlay: (joinCode, path) => localWorld.play(cleanCode(joinCode), safeInnerPath(path)),
  async shareStart() {
    const status = await shareTunnel.start();
    if (status.state !== "running") return fail(new Error(status.error || "Sharing failed."));
    return { ok: true, tunnel: status };
  },
  shareStop: async () => ({ ok: true, tunnel: await shareTunnel.stop() }),
  localAiScan: async () => fail(new Error("Local AI is desktop-only.")),
  localAiInstall: async () => fail(new Error("Local AI is desktop-only.")),
  localAiInstallComfy: async () => fail(new Error("Local AI is desktop-only.")),
  localAiUninstall: async () => fail(new Error("Local AI is desktop-only.")),
  localAiStatus: async () => ({
    supported: false,
    installedTierId: "",
    installedLabel: "",
    utilityInstalled: false,
    running: false,
    busy: "" as const,
    progress: null,
    error: "",
    comfy: { installed: false, running: false, checkpoint: "", error: "" },
  }),
  async appInfo() {
    // Capacitor knows the installed APK's version; a plain browser dev run
    // does not, and the About card copes with an empty string.
    const version = await App.getInfo()
      .then((info) => info.version)
      .catch(() => "");
    return { version, installKind: "android" as const };
  },
  // The store owns updates on Android; report "nothing to do" so the shared
  // About card renders as version-only without a special case crashing.
  updateCheck: async () => ({
    ok: true as const,
    update: { current: "", latest: "", available: false, canSelfUpdate: false, instruction: "" },
  }),
  updateInstall: async () => fail(new Error("Updates come through the app store on Android.")),

  onEvent(listener) {
    listeners.add(listener);
  },
};

window.odm = bridge;

// Closing the server webview lands back on the manager; closing it in the
// middle of a Discord sign-in is a cancel.
void InAppBrowser.addListener("closeEvent", () => {
  worldPageOpen = false;
  settleDiscord(fail(new Error("Sign-in cancelled.")));
  emit({ kind: "show-manager" });
});
void InAppBrowser.addListener("urlChangeEvent", ({ url }) => {
  void onWebviewUrl(String(url ?? ""));
});

// The hardware back gesture on the manager itself. Registering a listener
// takes the decision away from Capacitor's default (which walks WebView
// history and otherwise swallows the press); the shell UI decides whether
// it is on an inner screen or at home.
void App.addListener("backButton", () => emit({ kind: "back" }));

// Traffic from the injected game-page scripts: GATT calls from the Web
// Bluetooth polyfill and file exports from the download shim. The plugin
// copies the posted object's top-level keys onto the event, so a message
// posted as { detail: {...} } arrives under event.detail while one posted
// bare (the BLE polyfill's shape) is the event itself; accept both.
async function routeWebviewMessage(event: unknown): Promise<void> {
  const wrapped = event as { detail?: unknown } | null;
  const detail =
    wrapped && typeof wrapped === "object" && wrapped.detail !== undefined ? wrapped.detail : event;
  if (isShellRequest(detail)) {
    // "Switch server" from the page's account menu (shell-hook.js). The
    // plugin fires closeEvent for toolbar and back-button closes only, so
    // the manager is shown explicitly here.
    worldPageOpen = false;
    await InAppBrowser.close().catch(() => undefined);
    emit({ kind: "show-manager" });
    return;
  }
  const share = shareRequestOf(detail);
  if (share) {
    await handleShareRequest(share);
    return;
  }
  if (await bleRelay.handleMessage(detail)) return;
  await downloadRelay.handleMessage(detail);
}

function isShellRequest(detail: unknown): boolean {
  return (
    !!detail &&
    typeof detail === "object" &&
    (detail as { odmShell?: unknown }).odmShell === "servers"
  );
}

function shareRequestOf(detail: unknown): { action: string; id?: number } | null {
  if (!detail || typeof detail !== "object") return null;
  const message = detail as { odmShell?: unknown; action?: unknown; id?: unknown };
  if (message.odmShell !== "share" || typeof message.action !== "string") return null;
  return { action: message.action, id: typeof message.id === "number" ? message.id : undefined };
}
void InAppBrowser.addListener("messageFromWebview", (event) => {
  void routeWebviewMessage(event);
});

// Deep links: while running, and the one that may have launched the app.
void App.addListener("appUrlOpen", ({ url }) => void handleLink(url));
void App.getLaunchUrl().then((launch) => {
  if (launch?.url) void handleLink(launch.url);
});
