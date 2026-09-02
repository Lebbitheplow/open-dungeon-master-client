import { registerPlugin } from "@capacitor/core";
import type {
  AiSetup,
  ConnectResult,
  LocalStatus,
  Result,
  ShellEvent,
} from "../../src/shared/types";

// The phone-hosted world: the same server the desktop app bundles, run by a
// Node runtime inside this app (see android/.../WorldRuntime.java) and
// reached over http://127.0.0.1. This module mirrors the desktop shell's
// local flow (src/main/ipc.ts): a profile that feels like no account at
// all, silent re-login from a kept secret, and the one-time AI choice.

export interface WorldStatus {
  available: boolean;
  state: "unavailable" | "stopped" | "starting" | "running" | "stopping" | "error";
  origin: string;
  lanOrigin: string;
  firstRun: boolean;
  serverVersion: string;
  error: string;
}

export interface LocalWorldPlugin {
  status(): Promise<WorldStatus>;
  start(): Promise<WorldStatus>;
  stop(): Promise<WorldStatus>;
  log(): Promise<{ text: string }>;
}

export const LocalWorld = registerPlugin<LocalWorldPlugin>("LocalWorld");

// The on-device account. secret is the password the shell minted for a
// name-only profile (empty when the player chose their own), so an expired
// token renews without a form.
export interface LocalProfile {
  username: string;
  secret: string;
  token: string;
  tokenExpiresAt: string;
}

export interface TokenGrant {
  token: string;
  expiresAt: string;
  username: string;
}

export interface LocalWorldDeps {
  plugin: LocalWorldPlugin;
  loadProfile(): Promise<LocalProfile | null>;
  saveProfile(profile: LocalProfile | null): Promise<void>;
  loginForToken(origin: string, username: string, password: string): Promise<TokenGrant>;
  registerAccount(
    origin: string,
    input: { username: string; password: string; inviteCode: string },
  ): Promise<TokenGrant>;
  tokenIsValid(origin: string, token: string): Promise<boolean>;
  patchAdminSettings(origin: string, token: string, patch: object): Promise<void>;
  // Plants the session and opens the world's pages in the game webview.
  open(origin: string, token: string, joinCode: string): Promise<void>;
  emit(event: ShellEvent): void;
  randomSecret(): string;
}

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-5.1";

function tokenAlive(profile: LocalProfile | null): boolean {
  if (!profile?.token) return false;
  return !profile.tokenExpiresAt || Date.parse(profile.tokenExpiresAt) > Date.now();
}

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : "Something went wrong." };
}

export function createLocalWorld(deps: LocalWorldDeps) {
  async function status(): Promise<LocalStatus> {
    const world = await deps.plugin.status().catch(
      (): WorldStatus => ({
        available: false,
        state: "unavailable",
        origin: "",
        lanOrigin: "",
        firstRun: true,
        serverVersion: "",
        error: "",
      }),
    );
    const profile = await deps.loadProfile();
    return {
      state: world.available ? (world.state === "stopping" ? "stopped" : world.state) : "unavailable",
      origin: world.state === "running" ? world.origin : "",
      firstRun: world.firstRun,
      hasAccount: tokenAlive(profile),
      username: profile?.username ?? "",
      serverVersion: world.serverVersion,
      error: world.error,
      lanOrigin: world.state === "running" ? world.lanOrigin : "",
    };
  }

  async function announce(): Promise<void> {
    deps.emit({ kind: "local-status", status: await status() });
  }

  // Starts the server if needed and returns its local origin.
  async function start(): Promise<string> {
    const current = await deps.plugin.status();
    if (current.state === "running" && current.origin) return current.origin;
    deps.emit({ kind: "local-status", status: { ...(await status()), state: "starting" } });
    try {
      const started = await deps.plugin.start();
      if (started.state !== "running" || !started.origin) {
        throw new Error(started.error || "The world did not start.");
      }
      return started.origin;
    } finally {
      await announce();
    }
  }

  // Phone worlds always run mesh voice (no media server on a phone) and
  // point invite links at the phone's Wi-Fi address. Best effort, like the
  // desktop shell's equivalents.
  async function settleWorldSettings(origin: string, token: string): Promise<void> {
    const world = await deps.plugin.status().catch(() => null);
    const patch: Record<string, unknown> = { voiceChat: { enabled: "on", mode: "mesh" } };
    if (world?.lanOrigin) patch.publicUrl = world.lanOrigin;
    await deps.patchAdminSettings(origin, token, patch).catch(() => undefined);
  }

  async function adopt(grant: TokenGrant, secret: string): Promise<LocalProfile> {
    const profile: LocalProfile = {
      username: grant.username,
      secret,
      token: grant.token,
      tokenExpiresAt: grant.expiresAt,
    };
    await deps.saveProfile(profile);
    return profile;
  }

  // A live token for the profile, renewing silently from the kept secret;
  // null when the player must sign in (or does not exist yet).
  async function liveToken(origin: string): Promise<LocalProfile | null> {
    const profile = await deps.loadProfile();
    if (!profile) return null;
    if (tokenAlive(profile) && (await deps.tokenIsValid(origin, profile.token))) return profile;
    if (profile.secret) {
      try {
        const grant = await deps.loginForToken(origin, profile.username, profile.secret);
        return await adopt(grant, profile.secret);
      } catch {
        // Password changed inside the game; fall through to the form.
      }
    }
    return null;
  }

  async function play(joinCode: string): Promise<ConnectResult> {
    let origin: string;
    let freshWorld: boolean;
    try {
      freshWorld = (await deps.plugin.status()).firstRun;
      origin = await start();
    } catch (err) {
      return { ok: false, needsLogin: false, error: fail(err).error };
    }
    const profile = await liveToken(origin);
    if (!profile) {
      // A brand-new world asks who is playing; an existing one whose
      // profile was lost asks for the account behind it.
      if (freshWorld || !(await deps.loadProfile())) {
        return { ok: true, firstSetup: true, needsName: true };
      }
      return { ok: false, needsLogin: true, error: "Sign in to your world." };
    }
    await settleWorldSettings(origin, profile.token);
    await deps.open(origin, profile.token, joinCode);
    return { ok: true };
  }

  // Empty password means "mint one for me": the profile then behaves like
  // no account at all and renews itself. A chosen password is never kept.
  async function createAccount(input: {
    username: string;
    password: string;
  }): Promise<Result<{ status: LocalStatus }>> {
    try {
      const origin = await start();
      const minted = !input.password;
      const password = minted ? deps.randomSecret() : input.password;
      const grant = await deps.registerAccount(origin, {
        username: input.username,
        password,
        inviteCode: "",
      });
      const profile = await adopt(grant, minted ? password : "");
      await settleWorldSettings(origin, profile.token);
      return { ok: true, status: await status() };
    } catch (err) {
      return fail(err);
    }
  }

  async function login(input: {
    username: string;
    password: string;
  }): Promise<Result<{ status: LocalStatus }>> {
    try {
      const origin = await start();
      const grant = await deps.loginForToken(origin, input.username, input.password);
      await adopt(grant, "");
      return { ok: true, status: await status() };
    } catch (err) {
      return fail(err);
    }
  }

  async function configureAi(setup: AiSetup): Promise<Result> {
    try {
      const origin = await start();
      const profile = await liveToken(origin);
      if (!profile) return fail(new Error("Set up your profile first."));
      if (setup.choice === "human") {
        await deps.patchAdminSettings(origin, profile.token, { text: { provider: "none" } });
        return { ok: true };
      }
      if (setup.choice !== "openai") return { ok: true };
      const apiKey = setup.apiKey.trim();
      if (!apiKey) return fail(new Error("Enter the API key."));
      const model = setup.model.trim() || DEFAULT_MODEL;
      const utilityModel = setup.utilityModel.trim() || model;
      await deps.patchAdminSettings(origin, profile.token, {
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
  }

  async function stop(): Promise<void> {
    await deps.plugin.stop().catch(() => undefined);
    await announce();
  }

  return { status, start, play, createAccount, login, configureAi, stop };
}
