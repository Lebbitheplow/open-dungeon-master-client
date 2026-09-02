import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { LocalStatus } from "../shared/types";

// Runs the bundled Open Dungeon Master server (a Next.js standalone build
// produced by scripts/bundle-server.mjs) as a child process on localhost,
// using Electron's own binary in Node mode so no separate runtime ships.

interface PayloadInfo {
  serverVersion: string;
  builtAt: string;
}

const HEALTH_TIMEOUT_MS = 60_000;
const DEFAULT_PORT = 3210;

// Player-made data living inside the server tree that must survive a payload
// upgrade. The database itself lives outside the tree (SQLITE_DB_PATH).
const PRESERVED = [
  "public/uploads",
  "public/generated",
  "public/generated-audio",
  "public/ambience",
  "models",
];

function readPayloadInfo(dir: string): PayloadInfo | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dir, "odm-payload.json"), "utf8"),
    ) as PayloadInfo;
    if (parsed && typeof parsed.serverVersion === "string" && typeof parsed.builtAt === "string") {
      return parsed;
    }
  } catch {
    // No payload here.
  }
  return null;
}

export class LocalServer {
  private child: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private port = 0;
  private state: LocalStatus["state"] = "stopped";
  private error = "";
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly payloadDir: string,
    private readonly userDataDir: string,
  ) {}

  private get runDir(): string {
    return path.join(this.userDataDir, "local-server");
  }
  private get dataDir(): string {
    return path.join(this.userDataDir, "data");
  }
  private get dbPath(): string {
    return path.join(this.dataDir, "odm.sqlite");
  }
  get origin(): string {
    return this.port ? `http://127.0.0.1:${this.port}` : "";
  }
  get running(): boolean {
    return this.state === "running";
  }

  onStatus(listener: () => void): void {
    this.listeners.add(listener);
  }

  private setState(state: LocalStatus["state"], error = ""): void {
    this.state = state;
    this.error = error;
    for (const listener of this.listeners) listener();
  }

  status(hasAccount: boolean, username = ""): LocalStatus {
    const info = readPayloadInfo(this.payloadDir) ?? readPayloadInfo(this.runDir);
    return {
      state: info ? this.state : "unavailable",
      origin: this.state === "running" ? this.origin : "",
      firstRun: !fs.existsSync(this.dbPath),
      hasAccount,
      username,
      serverVersion: info?.serverVersion ?? "",
      error: this.error,
    };
  }

  // Copies the bundled payload into a writable run directory. The install
  // location can be read-only (AppImage mounts are), and the server writes
  // uploads and generated art next to its own public/ directory, so it has
  // to run from user data. Preserved directories survive upgrades.
  private syncRunTree(): void {
    const fresh = readPayloadInfo(this.payloadDir);
    if (!fresh) throw new Error("This build has no bundled server payload.");
    const current = readPayloadInfo(this.runDir);
    if (current && current.builtAt === fresh.builtAt) return;
    const keep = `${this.runDir}.keep`;
    fs.rmSync(keep, { recursive: true, force: true });
    if (current) {
      for (const rel of PRESERVED) {
        const from = path.join(this.runDir, rel);
        if (fs.existsSync(from)) fs.cpSync(from, path.join(keep, rel), { recursive: true });
      }
    }
    fs.rmSync(this.runDir, { recursive: true, force: true });
    fs.cpSync(this.payloadDir, this.runDir, { recursive: true });
    if (fs.existsSync(keep)) {
      fs.cpSync(keep, this.runDir, { recursive: true, force: true });
      fs.rmSync(keep, { recursive: true, force: true });
    }
  }

  private listenFree(port: number): Promise<number | null> {
    return new Promise((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(null));
      probe.listen({ host: "127.0.0.1", port }, () => {
        const address = probe.address();
        const got = typeof address === "object" && address ? address.port : null;
        probe.close(() => resolve(got));
      });
    });
  }

  private async pickPort(): Promise<number> {
    // Reuse the previous port when free so the local origin stays stable.
    const portFile = path.join(this.userDataDir, "local-port");
    let wanted = DEFAULT_PORT;
    try {
      wanted = Number(fs.readFileSync(portFile, "utf8").trim()) || DEFAULT_PORT;
    } catch {
      // First run.
    }
    const port = (await this.listenFree(wanted)) ?? (await this.listenFree(0));
    if (!port) throw new Error("No free local port for the bundled server.");
    fs.writeFileSync(portFile, String(port));
    return port;
  }

  private async waitHealthy(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error("The local server exited during startup (see local-server.log).");
      }
      try {
        const res = await fetch(`${this.origin}/api/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) return;
      } catch {
        // Not up yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("The local server did not become healthy in time.");
  }

  start(): Promise<void> {
    if (this.state === "running") return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  // The server encrypts its SQLite database and refuses to run without a
  // key. One is minted per install and kept next to the data it protects;
  // it guards the world file at rest, not against this OS user.
  private dbEncryptionKey(): string {
    const keyFile = path.join(this.dataDir, "db-key");
    try {
      const existing = fs.readFileSync(keyFile, "utf8").trim();
      if (existing) return existing;
    } catch {
      // First run.
    }
    const key = randomBytes(32).toString("hex");
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    return key;
  }

  private async doStart(): Promise<void> {
    this.setState("starting");
    try {
      this.syncRunTree();
      fs.mkdirSync(this.dataDir, { recursive: true });
      this.port = await this.pickPort();
      const log = fs.openSync(path.join(this.userDataDir, "local-server.log"), "a");
      const child = spawn(process.execPath, [path.join(this.runDir, "server.js")], {
        cwd: this.runDir,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          NODE_ENV: "production",
          PORT: String(this.port),
          HOSTNAME: "127.0.0.1",
          SQLITE_DB_PATH: this.dbPath,
          DB_ENCRYPTION_KEY: this.dbEncryptionKey(),
        },
        stdio: ["ignore", log, log],
      });
      fs.closeSync(log);
      this.child = child;
      child.once("exit", () => {
        if (this.child === child) {
          this.child = null;
          this.setState("error", "The local server stopped unexpectedly (see local-server.log).");
        }
      });
      await this.waitHealthy(child);
      this.setState("running");
    } catch (err) {
      await this.stop().catch(() => undefined);
      this.setState("error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.port = 0;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const killer = setTimeout(() => child.kill("SIGKILL"), 5000);
        child.once("exit", () => {
          clearTimeout(killer);
          resolve();
        });
      });
    }
    this.setState("stopped");
  }
}
