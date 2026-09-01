import { ipcMain } from "electron";
import type { AiSetup, ConnectResult, LocalStatus, Result, ServerSummary } from "../shared/types";
import { CODE_SHAPE, normalizeOrigin, originCandidates, type JoinLink } from "../shared/deep-link";
import type { LocalAiManager } from "./local-ai/manager";
import type { LocalServer } from "./local-server";
import {
  loginForToken,
  patchAdminSettings,
  probeServer,
  registerAccount,
  tokenIsValid,
  type TokenGrant,
} from "./odm-api";
import { LOCAL_SERVER_ID, type ServerStore, type StoredServer } from "./servers";
import { applySessionCookie, clearPartition, partitionFor } from "./session-cookies";
import type { QuickTunnel } from "./tunnel";
import type { ShellWindow } from "./window";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-5.1";

export interface ShellContext {
  store: ServerStore;
  window: ShellWindow;
  local: LocalServer;
  tunnel: QuickTunnel;
  localAi: LocalAiManager;
}

export interface ShellIpc {
  handleJoinLink(link: JoinLink): Promise<void>;
}

// Everything arriving over IPC is untrusted renderer input: coerce and cap.
function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function joinCodeOf(value: unknown): string {
  const code = str(value, 12).trim().toUpperCase();
  return CODE_SHAPE.test(code) ? code : "";
}

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : "Something went wrong." };
}

function summaryOf(entry: StoredServer): ServerSummary {
  return {
    id: entry.id,
    origin: entry.origin,
    name: entry.name,
    username: entry.username,
    lastUsedAt: entry.lastUsedAt,
    hasToken: true,
  };
}

export function registerIpc(ctx: ShellContext): ShellIpc {
  const { store, window: win, local, tunnel, localAi } = ctx;

  const localHasAccount = (): boolean => store.token(LOCAL_SERVER_ID) !== null;
  const localStatus = (): LocalStatus => local.status(localHasAccount());

  local.onStatus(() => win.sendEvent({ kind: "local-status", status: localStatus() }));
  tunnel.onStatus(() => win.sendEvent({ kind: "tunnel-status", status: tunnel.status() }));
  localAi.onStatus(() => win.sendEvent({ kind: "local-ai-progress", status: localAi.status() }));

  // Keeps the local server's publicUrl matching reality, so invite links and
  // QR codes generated inside the game point at the tunnel while one runs
  // (the host plays on 127.0.0.1, an address guests cannot reach) and go
  // back to normal when it stops. Best effort: links, not correctness.
  const syncPublicUrl = async (): Promise<void> => {
    const token = store.token(LOCAL_SERVER_ID);
    if (!token || !local.origin) return;
    const status = tunnel.status();
    await patchAdminSettings(local.origin, token, {
      publicUrl: status.state === "running" ? status.url : "",
    }).catch(() => undefined);
  };

  // Local worlds always run mesh voice: no media port to open, and it is the
  // only transport that survives a tunnel. Idempotent and best effort.
  const ensureLocalVoice = async (): Promise<void> => {
    const token = store.token(LOCAL_SERVER_ID);
    if (!token || !local.origin) return;
    await patchAdminSettings(local.origin, token, {
      voiceChat: { enabled: "on", mode: "mesh" },
    }).catch(() => undefined);
  };

  const attachRemote = async (
    entry: StoredServer,
    token: string,
    joinCode: string,
  ): Promise<void> => {
    await applySessionCookie(partitionFor(entry.id), entry.origin, token, entry.tokenExpiresAt);
    store.touch(entry.id);
    win.attachView(entry.origin, partitionFor(entry.id), joinCode ? `/join/${joinCode}` : "/");
  };

  const connectRemote = async (id: string, joinCode: string): Promise<ConnectResult> => {
    const entry = store.get(id);
    if (!entry || entry.id === LOCAL_SERVER_ID) {
      return { ok: false, needsLogin: false, error: "Unknown server." };
    }
    const token = store.token(id);
    if (!token || !(await tokenIsValid(entry.origin, token))) {
      return { ok: false, needsLogin: true, error: "Your session expired. Sign in again." };
    }
    await attachRemote(entry, token, joinCode);
    return { ok: true };
  };

  // Shared tail of login and register: remember the server, hand the session
  // to the web UI's partition, and show it.
  const adoptGrant = async (
    origin: string,
    grant: TokenGrant,
    joinCode: string,
  ): Promise<Result<{ server: ServerSummary }>> => {
    let name = "";
    try {
      name = (await probeServer(origin)).serverName;
    } catch {
      // The name is cosmetic; the login already proved the server is real.
    }
    const entry = store.upsert({
      origin,
      name: name || new URL(origin).host,
      username: grant.username,
      token: grant.token,
      tokenExpiresAt: grant.expiresAt,
    });
    await attachRemote(entry, grant.token, joinCode);
    return { ok: true, server: summaryOf(entry) };
  };

  ipcMain.handle("servers:list", () => ({
    servers: store.summaries(),
    local: localStatus(),
    tunnel: tunnel.status(),
  }));

  ipcMain.handle("share:start", async () => {
    try {
      await local.start();
      const port = Number(new URL(local.origin).port);
      const status = await tunnel.start(port);
      if (status.state !== "running") {
        return fail(new Error(status.error || "Sharing failed."));
      }
      await syncPublicUrl();
      // Older local worlds predate mesh voice; sharing is the moment it
      // matters, so heal the setting here too.
      await ensureLocalVoice();
      return { ok: true, tunnel: status };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle("share:stop", async () => {
    await tunnel.stop();
    await syncPublicUrl();
    return { ok: true, tunnel: tunnel.status() };
  });

  ipcMain.handle("servers:probe", async (_event, raw: unknown) => {
    let lastError: unknown = null;
    for (const origin of originCandidates(str(raw, 300))) {
      try {
        return { ok: true, probe: await probeServer(origin) };
      } catch (err) {
        lastError = err;
      }
    }
    return fail(lastError ?? new Error("That does not look like a server address."));
  });

  ipcMain.handle("servers:login", async (_event, input: Record<string, unknown>) => {
    try {
      const origin = normalizeOrigin(str(input?.origin, 300));
      if (!origin) return fail(new Error("Bad server address."));
      const grant = await loginForToken(origin, str(input?.username, 24), str(input?.password, 100));
      return await adoptGrant(origin, grant, joinCodeOf(input?.joinCode));
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle("servers:register", async (_event, input: Record<string, unknown>) => {
    try {
      const origin = normalizeOrigin(str(input?.origin, 300));
      if (!origin) return fail(new Error("Bad server address."));
      const grant = await registerAccount(origin, {
        username: str(input?.username, 24),
        password: str(input?.password, 100),
        inviteCode: str(input?.inviteCode, 40).trim(),
      });
      return await adoptGrant(origin, grant, joinCodeOf(input?.joinCode));
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle("servers:connect", (_event, id: unknown, joinCode: unknown) =>
    connectRemote(str(id, 64), joinCodeOf(joinCode)),
  );

  ipcMain.handle("servers:remove", async (_event, id: unknown) => {
    const serverId = str(id, 64);
    if (!serverId || serverId === LOCAL_SERVER_ID) return;
    store.remove(serverId);
    await clearPartition(partitionFor(serverId));
  });

  ipcMain.handle("local:start", async () => {
    try {
      await local.start();
      return { ok: true, status: localStatus() };
    } catch (err) {
      return fail(err);
    }
  });

  const adoptLocalGrant = (grant: TokenGrant): void => {
    store.upsert({
      id: LOCAL_SERVER_ID,
      origin: "local",
      name: "This computer",
      username: grant.username,
      token: grant.token,
      tokenExpiresAt: grant.expiresAt,
    });
  };

  ipcMain.handle("local:create-account", async (_event, input: Record<string, unknown>) => {
    try {
      await local.start();
      const grant = await registerAccount(local.origin, {
        username: str(input?.username, 24),
        password: str(input?.password, 100),
        inviteCode: "",
      });
      adoptLocalGrant(grant);
      await ensureLocalVoice();
      return { ok: true, status: localStatus() };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle("local:login", async (_event, input: Record<string, unknown>) => {
    try {
      await local.start();
      const grant = await loginForToken(
        local.origin,
        str(input?.username, 24),
        str(input?.password, 100),
      );
      adoptLocalGrant(grant);
      return { ok: true, status: localStatus() };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle("local:configure-ai", async (_event, setup: AiSetup) => {
    try {
      const token = store.token(LOCAL_SERVER_ID);
      if (!token || !local.origin) return fail(new Error("Set up the local account first."));
      if (setup?.choice !== "openai") return { ok: true };
      const apiKey = str(setup.apiKey, 400).trim();
      if (!apiKey) return fail(new Error("Enter the API key."));
      const model = str(setup.model, 200).trim() || DEFAULT_MODEL;
      const utilityModel = str(setup.utilityModel, 200).trim() || model;
      await patchAdminSettings(local.origin, token, {
        text: {
          provider: "custom",
          customBaseUrl: OPENAI_BASE_URL,
          customModel: model,
          customApiKey: apiKey,
          utilityProvider: "custom",
          utilityBaseUrl: OPENAI_BASE_URL,
          utilityModel,
          utilityApiKey: apiKey,
        },
        images: { defaultBackend: "openai", openaiApiKey: apiKey },
      });
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle("local:play", async (_event, joinCode: unknown): Promise<ConnectResult> => {
    try {
      await local.start();
    } catch (err) {
      return { ok: false, needsLogin: false, error: fail(err).error };
    }
    // A crash while sharing can leave a stale publicUrl behind; heal it.
    void syncPublicUrl();
    // A model was installed: warm the AI server in the background. The first
    // AI turn simply waits for the load if the player beats it.
    void localAi.start();
    const entry = store.get(LOCAL_SERVER_ID);
    const token = store.token(LOCAL_SERVER_ID);
    if (!entry || !token || !(await tokenIsValid(local.origin, token))) {
      return { ok: false, needsLogin: true, error: "Sign in to your local account." };
    }
    await applySessionCookie(
      partitionFor(LOCAL_SERVER_ID),
      local.origin,
      token,
      entry.tokenExpiresAt,
    );
    const code = joinCodeOf(joinCode);
    win.attachView(local.origin, partitionFor(LOCAL_SERVER_ID), code ? `/join/${code}` : "/");
    return { ok: true };
  });

  ipcMain.handle("local-ai:status", () => localAi.status());

  ipcMain.handle("local-ai:scan", async () => {
    try {
      const result = await localAi.scan();
      return { ok: true, ...result };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle("local-ai:install", async (_event, tierId: unknown) => {
    try {
      await localAi.install(str(tierId, 40));
      // Point the local world's AI at the freshly installed model. The base
      // URL is the ODM server's own local default; the alias tells it which
      // model name to request from the llama-server preset.
      const token = store.token(LOCAL_SERVER_ID);
      const alias = localAi.installedAlias();
      if (token && local.origin && alias) {
        const base = "http://127.0.0.1:8001/v1";
        await patchAdminSettings(local.origin, token, {
          text: {
            provider: "custom",
            customBaseUrl: base,
            customModel: alias,
            customApiKey: "",
            utilityProvider: "custom",
            utilityBaseUrl: base,
            utilityModel: alias,
            utilityApiKey: "",
          },
        }).catch(() => undefined);
      }
      void localAi.start();
      return { ok: true, status: localAi.status() };
    } catch (err) {
      return fail(err);
    }
  });

  return {
    async handleJoinLink(link: JoinLink): Promise<void> {
      win.focus();
      const known = store.findByOrigin(link.origin);
      if (known) {
        const result = await connectRemote(known.id, link.code);
        if (result.ok) return;
      }
      win.showManager();
      win.sendEvent({
        kind: "join-request",
        origin: link.origin,
        code: link.code,
        knownServerId: known?.id ?? "",
      });
    },
  };
}
