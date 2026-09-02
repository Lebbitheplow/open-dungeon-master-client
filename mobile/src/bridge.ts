import { App } from "@capacitor/app";
import { BleClient } from "@capacitor-community/bluetooth-le";
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from "@capacitor/barcode-scanner";
import { CapacitorCookies, CapacitorHttp } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Preferences } from "@capacitor/preferences";
import { InAppBrowser, ToolBarType } from "@capgo/inappbrowser";
import { createBleRelay } from "./ble-relay";
import {
  CODE_SHAPE,
  normalizeOrigin,
  originCandidates,
  parseAnyLink,
  type JoinLink,
} from "../../src/shared/deep-link";
import type {
  ConnectResult,
  LocalStatus,
  TunnelStatus,
  OdmBridge,
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
// Connect-only: the bundled offline server is desktop-only, so local play
// reports "unavailable" and the UI hides the card.

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

async function tokenIsValid(origin: string, token: string): Promise<boolean> {
  try {
    return (await http(origin, "/api/auth/me", { token })).status === 200;
  } catch {
    return false;
  }
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

// The manager UI ships the polyfill as a sibling asset; missing or failing
// to load it must never block connecting, it only disables dice pairing.
let blePolyfill: Promise<string> | null = null;

function loadBlePolyfill(): Promise<string> {
  blePolyfill ??= fetch("ble-polyfill.js")
    .then((response) => (response.ok ? response.text() : ""))
    .catch(() => "");
  return blePolyfill;
}

async function openServer(server: StoredServer, joinCode: string): Promise<void> {
  await CapacitorCookies.setCookie({
    url: server.origin,
    key: "odm_session",
    value: server.token,
  });
  const preShowScript = await loadBlePolyfill();
  await InAppBrowser.openWebView({
    url: `${server.origin}${joinCode ? `/join/${joinCode}` : "/"}`,
    toolbarType: ToolBarType.COMPACT,
    title: server.name,
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

async function connectById(id: string, joinCode: string): Promise<ConnectResult> {
  const servers = await loadServers();
  const server = servers.find((entry) => entry.id === id);
  if (!server) return { ok: false, needsLogin: false, error: "Unknown server." };
  if (!tokenAlive(server) || !(await tokenIsValid(server.origin, server.token))) {
    return { ok: false, needsLogin: true, error: "Your session expired. Sign in again." };
  }
  server.lastUsedAt = new Date().toISOString();
  await saveServers(servers);
  await openServer(server, joinCode);
  return { ok: true };
}

async function adoptGrant(
  origin: string,
  grant: TokenGrant,
  joinCode: string,
): Promise<Result<{ server: ServerSummary }>> {
  let name = "";
  try {
    name = (await probeOrigin(origin)).serverName;
  } catch {
    // Cosmetic; the login already proved the server is real.
  }
  const servers = await loadServers();
  const existing = servers.find((entry) => entry.origin === origin);
  const server: StoredServer = {
    id: existing?.id ?? crypto.randomUUID(),
    origin,
    name: name || new URL(origin).host,
    username: grant.username,
    lastUsedAt: new Date().toISOString(),
    token: grant.token,
    tokenExpiresAt: grant.expiresAt,
  };
  if (existing) servers[servers.indexOf(existing)] = server;
  else servers.push(server);
  await saveServers(servers);
  await openServer(server, joinCode);
  return { ok: true, server: summaryOf(server) };
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
  const known = servers.find((entry) => entry.origin === link.origin);
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

const LOCAL_UNAVAILABLE: LocalStatus = {
  state: "unavailable",
  origin: "",
  firstRun: false,
  hasAccount: false,
  serverVersion: "",
  error: "",
};

const TUNNEL_STOPPED: TunnelStatus = { state: "stopped", url: "", mode: "", error: "" };

const notLocal = async (): Promise<Result<{ status: LocalStatus }>> => ({
  ok: false,
  error: "Offline play lives in the desktop app for now.",
});

const bridge: OdmBridge = {
  platform: "android",

  async listServers() {
    const servers = await loadServers();
    servers.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
    return { servers: servers.map(summaryOf), local: LOCAL_UNAVAILABLE, tunnel: TUNNEL_STOPPED };
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

  connect: (serverId, joinCode) => connectById(String(serverId), cleanCode(joinCode)),

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

  async removeServer(serverId) {
    const servers = await loadServers();
    const server = servers.find((entry) => entry.id === serverId);
    await saveServers(servers.filter((entry) => entry.id !== serverId));
    if (server) {
      await CapacitorCookies.clearCookies({ url: server.origin }).catch(() => undefined);
    }
  },

  localStart: notLocal,
  localCreateAccount: notLocal,
  localLogin: notLocal,
  localConfigureAi: async () => fail(new Error("Offline play is desktop-only.")),
  localPlay: async () => ({
    ok: false,
    needsLogin: false,
    error: "Offline play lives in the desktop app for now.",
  }),
  shareStart: async () => fail(new Error("Hosting online is desktop-only for now.")),
  shareStop: async () => fail(new Error("Hosting online is desktop-only for now.")),
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

// Closing the server webview lands back on the manager.
void InAppBrowser.addListener("closeEvent", () => emit({ kind: "show-manager" }));

// GATT traffic from the injected Web Bluetooth polyfill.
void InAppBrowser.addListener("messageFromWebview", (event) => {
  void bleRelay.handleMessage(event.detail);
});

// Deep links: while running, and the one that may have launched the app.
void App.addListener("appUrlOpen", ({ url }) => void handleLink(url));
void App.getLaunchUrl().then((launch) => {
  if (launch?.url) void handleLink(launch.url);
});
