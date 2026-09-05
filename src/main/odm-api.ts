import type { AccountDeletionResult, ServerProbe, SignupMode } from "../shared/types";

// Thin fetch helpers for talking to an Open Dungeon Master server's REST API
// from the main process. Errors are thrown as ApiError with a message safe to
// show in the shell UI.

const TIMEOUT_MS = 10_000;

export class ApiError extends Error {}

async function api(origin: string, pathname: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${origin}${pathname}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(`Could not reach ${origin}. Check the address and your connection.`);
  }
}

async function errorFrom(res: Response, fallback: string): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new ApiError(body?.error || fallback);
}

export async function probeServer(origin: string): Promise<ServerProbe> {
  const res = await api(origin, "/api/auth/providers");
  const body = res.ok
    ? ((await res.json().catch(() => null)) as {
        discord?: boolean;
        password?: boolean;
        signupMode?: string;
        serverName?: string;
        version?: string;
        instanceId?: string;
      } | null)
    : null;
  if (!body || typeof body.password !== "boolean") {
    throw new ApiError(`${origin} does not look like an Open Dungeon Master server.`);
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

export interface TokenGrant {
  token: string;
  expiresAt: string;
  username: string;
  isAdmin: boolean;
}

export async function loginForToken(
  origin: string,
  username: string,
  password: string,
): Promise<TokenGrant> {
  const res = await api(origin, "/api/auth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw await errorFrom(res, "Sign-in failed.");
  const body = (await res.json()) as {
    token: string;
    expiresAt: string;
    user: { username: string; isAdmin: boolean };
  };
  return {
    token: body.token,
    expiresAt: body.expiresAt,
    username: body.user.username,
    isAdmin: Boolean(body.user.isAdmin),
  };
}

export async function registerAccount(
  origin: string,
  input: { username: string; password: string; inviteCode: string },
): Promise<TokenGrant> {
  const payload: Record<string, string> = {
    username: input.username,
    password: input.password,
  };
  if (input.inviteCode) payload.inviteCode = input.inviteCode;
  const res = await api(origin, "/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await errorFrom(res, "Could not create the account.");
  // Registration set a browser cookie this process never sees; mint the
  // app's own bearer token with the same credentials.
  return loginForToken(origin, input.username, input.password);
}

// Who a session belongs to; used after a browser sign-in (Discord OAuth)
// hands the shell a token it did not mint itself.
export async function whoAmI(
  origin: string,
  token: string,
): Promise<{ username: string; isAdmin: boolean }> {
  const res = await api(origin, "/api/auth/me", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await errorFrom(res, "The sign-in did not produce a usable session.");
  const body = (await res.json().catch(() => null)) as {
    user?: { username?: string; isAdmin?: boolean };
  } | null;
  if (!body?.user || typeof body.user.username !== "string") {
    throw new ApiError("The sign-in did not produce a usable session.");
  }
  return { username: body.user.username, isAdmin: Boolean(body.user.isAdmin) };
}

export async function tokenIsValid(origin: string, token: string): Promise<boolean> {
  try {
    const res = await api(origin, "/api/auth/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function patchAdminSettings(
  origin: string,
  token: string,
  patch: object,
): Promise<void> {
  const res = await api(origin, "/api/admin/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await errorFrom(res, "Saving server settings failed.");
}

// Self-service account deletion (the server's DELETE /api/profile). Password
// accounts must send their password; Discord-only accounts send "".
export async function deleteAccount(
  origin: string,
  token: string,
  password: string,
): Promise<AccountDeletionResult> {
  const res = await api(origin, "/api/profile", {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(password ? { password } : {}),
  });
  if (!res.ok) throw await errorFrom(res, "Could not delete the account.");
  const body = (await res.json().catch(() => null)) as {
    dueAt?: string;
    graceDays?: number;
    purged?: boolean;
  } | null;
  return {
    dueAt: typeof body?.dueAt === "string" ? body.dueAt : "",
    graceDays: typeof body?.graceDays === "number" ? body.graceDays : 0,
    purged: body?.purged === true,
  };
}
