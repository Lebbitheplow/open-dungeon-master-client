import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
}

// Injected so tests can run without Electron's safeStorage.
export interface TokenCrypt {
  encrypt(plain: string): string;
  decrypt(cipher: string): string | null;
}

interface RegistryFile {
  version: 1;
  servers: StoredServer[];
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

  // Adds or refreshes a server entry. Remote entries dedupe by origin; the
  // local entry is addressed by its fixed id.
  upsert(input: {
    id?: string;
    origin: string;
    name: string;
    username: string;
    token: string;
    tokenExpiresAt: string;
    secret?: string;
  }): StoredServer {
    const registry = this.load();
    const existing = registry.servers.find((server) =>
      input.id ? server.id === input.id : server.id !== LOCAL_SERVER_ID && server.origin === input.origin,
    );
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

  touch(id: string): void {
    const registry = this.load();
    const server = registry.servers.find((entry) => entry.id === id);
    if (!server) return;
    server.lastUsedAt = new Date().toISOString();
    this.save(registry);
  }

  remove(id: string): void {
    const registry = this.load();
    registry.servers = registry.servers.filter((server) => server.id !== id);
    this.save(registry);
  }
}
