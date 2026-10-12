import type { ServerProbe } from "../shared/types";
import type { SessionState, TokenGrant } from "./odm-api";
import { LOCAL_SERVER_ID, type ServerStore, type StoredServer } from "./servers";

export type PreparedRemote =
  | { ok: true; entry: StoredServer; token: string; probe: ServerProbe }
  | { ok: false; needsLogin: boolean; error: string };

export async function prepareRemoteConnection(id: string, deps: {
  store: ServerStore;
  probe: (origin: string) => Promise<ServerProbe | null>;
  relocate: (entry: StoredServer) => Promise<StoredServer>;
  sessionState: (origin: string, token: string) => Promise<SessionState>;
  login: (origin: string, username: string, secret: string) => Promise<TokenGrant>;
}): Promise<PreparedRemote> {
  const saved = deps.store.get(id);
  if (!saved || saved.id === LOCAL_SERVER_ID) {
    return { ok: false, needsLogin: false, error: "Unknown server." };
  }
  let entry = saved;
  const notOnline = (): PreparedRemote => ({
    ok: false,
    needsLogin: false,
    error: `${entry.name} is not online right now. Ask the host to share their world, then try again.`,
  });
  let probe = await deps.probe(entry.origin).catch(() => null);
  if (!probe || (!!entry.instanceId && probe.instanceId !== entry.instanceId)) {
    const moved = await deps.relocate(entry);
    if (moved.origin === entry.origin) return notOnline();
    entry = moved;
    probe = await deps.probe(entry.origin).catch(() => null);
    if (!probe || (!!entry.instanceId && probe.instanceId !== entry.instanceId)) return notOnline();
  }
  let token = deps.store.token(id);
  const session = token ? await deps.sessionState(entry.origin, token) : "rejected";
  if (session === "unreachable") return notOnline();
  if (session === "rejected") {
    const secret = deps.store.secret(id);
    token = null;
    if (secret) {
      try {
        const grant = await deps.login(entry.origin, entry.username, secret);
        entry = deps.store.upsert({
          id: entry.id,
          origin: entry.origin,
          name: entry.name,
          username: grant.username,
          token: grant.token,
          tokenExpiresAt: grant.expiresAt,
        });
        token = grant.token;
      } catch {
        // A changed password requires the regular sign-in or rejoin path.
      }
    }
  }
  if (!token) {
    return {
      ok: false,
      needsLogin: true,
      error: probe.deviceWorld
        ? "Your seat at this world could not be reopened. Join again with a name, and ask the host to remove the old one."
        : "Your session expired. Sign in again.",
    };
  }
  return { ok: true, entry, token, probe };
}
