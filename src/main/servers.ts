import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HomeCache } from "../shared/home-feed-logic";
import type { ServerSummary } from "../shared/types";

// The reserved id for the bundled offline server's account entry. Its origin
// changes with the local port, so it is always looked up by id, never origin.
export const LOCAL_SERVER_ID = "local";

// One remembered server. The session token is stored encrypted (OS keychain
// via safeStorage where available); everything else is plain JSON.
// secretCipher holds the auto-provisioned local profile's password so the
// shell can sign back in when the session token expires; remote servers
// never store passwords.
export interface StoredServer {
  id: string;
  origin: string;
  name: string;
  username: string;
  lastUsedAt: string;
  tokenCipher: string;
  tokenExpiresAt: string;
  secretCipher?: string;
  // The world's stable id from /api/auth/providers ("" or absent on servers
  // that predate it). Lets the shell recognize a device world that came back
  // at a new tunnel address and move this entry there instead of adding a
  // duplicate.
  instanceId?: string;
}

// Injected so tests can run without Electron's safeStorage.
export interface TokenCrypt {
  encrypt(plain: string): string;
  decrypt(cipher: string): string | null;
}

interface RegistryFile {
  version: 1;
  servers: StoredServer[];
  // The home screen's last campaign list per host id (the local entry
  // included), so an unreachable host still lists what it had.
  homeCache?: HomeCache;
}

export class ServerStore {
  constructor(
    private readonly file: string,
    private readonly crypt: TokenCrypt,
  ) {}

  private load(): RegistryFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as RegistryFile;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.servers)) return parsed;
    } catch {
      // Missing or corrupt registry: start clean rather than crash the shell.
    }
    return { version: 1, servers: [] };
  }

  private save(registry: RegistryFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // Remote servers only, most recently used first.
  list(): StoredServer[] {
    return this.load()
      .servers.filter((server) => server.id !== LOCAL_SERVER_ID)
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  }

  summaries(): ServerSummary[] {
    return this.list().map((server) => ({
      id: server.id,
      origin: server.origin,
      name: server.name,
      username: server.username,
      lastUsedAt: server.lastUsedAt,
      hasToken: this.token(server.id) !== null,
    }));
  }

  get(id: string): StoredServer | null {
    return this.load().servers.find((server) => server.id === id) ?? null;
  }

  findByOrigin(origin: string): StoredServer | null {
    return (
      this.load().servers.find(
        (server) => server.id !== LOCAL_SERVER_ID && server.origin === origin,
      ) ?? null
    );
  }

  findByInstanceId(instanceId: string): StoredServer | null {
    if (!instanceId) return null;
    return (
      this.load().servers.find(
        (server) => server.id !== LOCAL_SERVER_ID && server.instanceId === instanceId,
      ) ?? null
    );
  }

  // Adds or refreshes a server entry. Remote entries dedupe by origin, then
  // by the world's instanceId (a device world back at a new tunnel address);
  // the local entry is addressed by its fixed id.
  upsert(input: {
    id?: string;
    origin: string;
    name: string;
    username: string;
    token: string;
    tokenExpiresAt: string;
    secret?: string;
    instanceId?: string;
  }): StoredServer {
    const registry = this.load();
    const existing =
      registry.servers.find((server) =>
        input.id ? server.id === input.id : server.id !== LOCAL_SERVER_ID && server.origin === input.origin,
      ) ??
      (input.id || !input.instanceId
        ? undefined
        : registry.servers.find(
            (server) => server.id !== LOCAL_SERVER_ID && server.instanceId === input.instanceId,
          ));
    const entry: StoredServer = {
      id: existing?.id ?? input.id ?? randomUUID(),
      origin: input.origin,
      name: input.name,
      username: input.username,
      lastUsedAt: new Date().toISOString(),
      tokenCipher: this.crypt.encrypt(input.token),
      tokenExpiresAt: input.tokenExpiresAt,
      // A token refresh must not drop the stored local password.
      secretCipher:
        input.secret !== undefined ? this.crypt.encrypt(input.secret) : existing?.secretCipher,
      instanceId: input.instanceId || existing?.instanceId,
    };
    if (existing) {
      registry.servers[registry.servers.indexOf(existing)] = entry;
    } else {
      registry.servers.push(entry);
    }
    this.save(registry);
    return entry;
  }

  // The decrypted session token, or null when absent, expired, or
  // undecryptable (e.g. the OS keychain changed).
  token(id: string): string | null {
    const server = this.get(id);
    if (!server || !server.tokenCipher) return null;
    if (server.tokenExpiresAt && Date.parse(server.tokenExpiresAt) <= Date.now()) return null;
    return this.crypt.decrypt(server.tokenCipher);
  }

  // The stored local profile password, or null when absent or undecryptable.
  secret(id: string): string | null {
    const server = this.get(id);
    if (!server?.secretCipher) return null;
    return this.crypt.decrypt(server.secretCipher);
  }

  // Forgets only the session token. The entry stays (so the server list
  // still offers the server) and so does any stored local profile secret,
  // which is what lets the local world's next Play sign back in silently.
  clearToken(id: string): void {
    const registry = this.load();
    const server = registry.servers.find((entry) => entry.id === id);
    if (!server || !server.tokenCipher) return;
    server.tokenCipher = "";
    server.tokenExpiresAt = "";
    this.save(registry);
  }

  touch(id: string): void {
    const registry = this.load();
    const server = registry.servers.find((entry) => entry.id === id);
    if (!server) return;
    server.lastUsedAt = new Date().toISOString();
    this.save(registry);
  }

  // Moves an entry to a new address, keeping its id, token and home cache:
  // the same world reached a different way, not a different server.
  rebindOrigin(id: string, origin: string): StoredServer | null {
    const registry = this.load();
    const server = registry.servers.find((entry) => entry.id === id);
    if (!server) return null;
    server.origin = origin;
    server.lastUsedAt = new Date().toISOString();
    this.save(registry);
    return server;
  }

  // Best-effort backfill for entries saved before the server exposed its
  // instanceId (or before this shell stored it).
  setInstanceId(id: string, instanceId: string): void {
    if (!instanceId) return;
    const registry = this.load();
    const server = registry.servers.find((entry) => entry.id === id);
    if (!server || server.instanceId === instanceId) return;
    server.instanceId = instanceId;
    this.save(registry);
  }

  remove(id: string): void {
    const registry = this.load();
    registry.servers = registry.servers.filter((server) => server.id !== id);
    if (registry.homeCache) delete registry.homeCache[id];
    this.save(registry);
  }

  homeCache(): HomeCache {
    const cache = this.load().homeCache;
    return cache && typeof cache === "object" && !Array.isArray(cache) ? cache : {};
  }

  // Replaces the whole record: the feed writes every host it knows in one
  // go, which also forgets hosts that are gone.
  saveHomeCache(cache: HomeCache): void {
    const registry = this.load();
    registry.homeCache = cache;
    this.save(registry);
  }
}
