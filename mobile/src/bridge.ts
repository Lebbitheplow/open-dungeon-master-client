import { App } from "@capacitor/app";
import { CapacitorCookies, CapacitorHttp } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { InAppBrowser, ToolBarType } from "@capgo/inappbrowser";
import {
  CODE_SHAPE,
  normalizeOrigin,
  originCandidates,
  parseJoinLink,
  type JoinLink,
} from "../../src/shared/deep-link";
import type {
  ConnectResult,
  LocalStatus,
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

async function openServer(server: StoredServer, joinCode: string): Promise<void> {
  await CapacitorCookies.setCookie({
    url: server.origin,
    key: "odm_session",
    value: server.token,
  });
  await InAppBrowser.openWebView({
    url: `${server.origin}${joinCode ? `/join/${joinCode}` : "/"}`,
    toolbarType: ToolBarType.COMPACT,
    title: server.name,
  });
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

function parseAnyLink(raw: string): JoinLink | null {
  const direct = parseJoinLink(raw);
  if (direct) return direct;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.host !== "opendungeonmaster.com") return null;
  if (!url.pathname.startsWith("/j")) return null;
  const origin = normalizeOrigin(url.searchParams.get("s") ?? "");
  const code = cleanCode(url.searchParams.get("c") ?? url.pathname.split("/")[2] ?? "");
  return origin && code ? { origin, code } : null;
}

async function handleLink(raw: string): Promise<void> {
  const link = parseAnyLink(raw);
  if (!link) return;
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

// ---------- the bridge ----------

const LOCAL_UNAVAILABLE: LocalStatus = {
  state: "unavailable",
  origin: "",
  firstRun: false,
  hasAccount: false,
  serverVersion: "",
  error: "",
};

const notLocal = async (): Promise<Result<{ status: LocalStatus }>> => ({
  ok: false,
  error: "Offline play lives in the desktop app for now.",
});

const bridge: OdmBridge = {
  platform: "android",

  async listServers() {
    const servers = await loadServers();
    servers.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
    return { servers: servers.map(summaryOf), local: LOCAL_UNAVAILABLE };
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

  onEvent(listener) {
    listeners.add(listener);
  },
};

window.odm = bridge;

// Closing the server webview lands back on the manager.
void InAppBrowser.addListener("closeEvent", () => emit({ kind: "show-manager" }));

// Deep links: while running, and the one that may have launched the app.
void App.addListener("appUrlOpen", ({ url }) => void handleLink(url));
void App.getLaunchUrl().then((launch) => {
  if (launch?.url) void handleLink(launch.url);
});
