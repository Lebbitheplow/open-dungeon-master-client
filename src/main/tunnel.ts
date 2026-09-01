import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { TunnelStatus } from "../shared/types";

// Hosts an offline world on the public internet through a Cloudflare quick
// tunnel: no account, no port forwarding, a random https address on
// trycloudflare.com. Friends join in any browser; the session lives as long
// as the app keeps the tunnel up. The pretty CODE.play.opendungeonmaster.com
// names come later from the broker Worker; the plumbing here is the same.

const URL_SHAPE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const URL_WAIT_MS = 45_000;
const REACHABLE_WAIT_MS = 90_000;

// The broker Worker that mints CODE.play.opendungeonmaster.com sessions
// (workers/tunnel-broker in the server repo). When it cannot help (offline,
// rate limited, not configured), hosting falls back to a quick tunnel.
const DEFAULT_BROKER_URL = "https://odm-tunnel-broker.tunnel-broker.workers.dev";

interface BrokerSession {
  code: string;
  url: string;
  hostname: string;
  tunnelToken: string;
  secret: string;
}

function brokerUrl(): string {
  return process.env.ODM_BROKER_URL || DEFAULT_BROKER_URL;
}

// cloudflared is a single static binary. It is fetched once per install from
// Cloudflare's official GitHub releases and never auto-updates itself
// (--no-autoupdate). macOS publishes a .tgz instead of a bare binary; that
// is handled when the mac build lands.
function downloadUrl(): string | null {
  const base = "https://github.com/cloudflare/cloudflared/releases/latest/download";
  if (process.platform === "linux") {
    return `${base}/cloudflared-linux-${process.arch === "arm64" ? "arm64" : "amd64"}`;
  }
  if (process.platform === "win32") {
    return `${base}/cloudflared-windows-amd64.exe`;
  }
  return null;
}

export class QuickTunnel {
  private child: ChildProcess | null = null;
  private startPromise: Promise<TunnelStatus> | null = null;
  private state: TunnelStatus["state"] = "stopped";
  private url = "";
  private mode: TunnelStatus["mode"] = "";
  private session: BrokerSession | null = null;
  private error = "";
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly binDir: string,
    private readonly logFile: string,
  ) {}

  status(): TunnelStatus {
    return {
      state: this.state,
      url: this.state === "running" ? this.url : "",
      mode: this.state === "running" ? this.mode : "",
      error: this.error,
    };
  }

  onStatus(listener: () => void): void {
    this.listeners.add(listener);
  }

  private setState(state: TunnelStatus["state"], error = ""): void {
    this.state = state;
    this.error = error;
    for (const listener of this.listeners) listener();
  }

  private binPath(): string {
    return path.join(this.binDir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  }

  async ensureBinary(): Promise<string> {
    const target = this.binPath();
    if (fs.existsSync(target)) return target;
    const url = downloadUrl();
    if (!url) throw new Error("Sharing online is not supported on this platform yet.");
    fs.mkdirSync(this.binDir, { recursive: true });
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error("Downloading the tunnel helper (cloudflared) failed. Check your connection.");
    }
    const partial = `${target}.part`;
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      fs.createWriteStream(partial, { mode: 0o755 }),
    );
    fs.renameSync(partial, target);
    return target;
  }

  // Asks the broker for a named CODE.play session. Any failure (offline,
  // rate limit, broker unconfigured) returns null and the quick-tunnel
  // fallback takes over.
  private async requestBrokerSession(localPort: number): Promise<BrokerSession | null> {
    try {
      const response = await fetch(`${brokerUrl()}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: localPort }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as Partial<BrokerSession>;
      if (!body?.tunnelToken || !body?.hostname || !body?.code || !body?.secret) return null;
      return {
        code: body.code,
        url: body.url || `https://${body.hostname}`,
        hostname: body.hostname,
        tunnelToken: body.tunnelToken,
        secret: body.secret,
      };
    } catch {
      return null;
    }
  }

  private async releaseBrokerSession(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (!session) return;
    await fetch(`${brokerUrl()}/session/${session.code}`, {
      method: "DELETE",
      headers: { "x-session-secret": session.secret },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }

  private attachLog(child: ChildProcess): void {
    const log = fs.createWriteStream(this.logFile, { flags: "a" });
    child.stdout?.on("data", (chunk) => log.write(chunk));
    child.stderr?.on("data", (chunk) => log.write(chunk));
    child.once("exit", () => log.end());
  }

  // Watches cloudflared's log output for the assigned public URL.
  private captureUrl(child: ChildProcess): Promise<string> {
    return new Promise((resolve, reject) => {
      const log = fs.createWriteStream(this.logFile, { flags: "a" });
      let done = false;
      const finish = (err: Error | null, url = ""): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(url);
      };
      const timer = setTimeout(
        () => finish(new Error("The tunnel never reported its address (see tunnel.log).")),
        URL_WAIT_MS,
      );
      const scan = (chunk: Buffer): void => {
        log.write(chunk);
        const match = URL_SHAPE.exec(chunk.toString());
        if (match) finish(null, match[0]);
      };
      child.stdout?.on("data", scan);
      child.stderr?.on("data", scan);
      child.once("exit", () => {
        log.end();
        finish(new Error("cloudflared exited during startup (see tunnel.log)."));
      });
    });
  }

  // A freshly minted quick-tunnel hostname takes a few seconds to appear in
  // DNS. Asking the OS resolver too early gets an NXDOMAIN that
  // systemd-resolved then negative-caches, wedging every retry. So the name
  // is confirmed over DNS-over-HTTPS first, which never touches the local
  // resolver cache.
  private async waitDns(host: string, child: ChildProcess): Promise<void> {
    const deadline = Date.now() + REACHABLE_WAIT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("The tunnel closed while warming up.");
      try {
        const response = await fetch(
          `https://cloudflare-dns.com/dns-query?name=${host}&type=A`,
          { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(4000) },
        );
        const body = (await response.json()) as { Answer?: unknown[] };
        if (Array.isArray(body.Answer) && body.Answer.length > 0) return;
      } catch {
        // DoH hiccup; keep waiting.
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error("The tunnel's address never appeared in DNS.");
  }

  // The edge needs a moment to route a fresh quick tunnel; a URL that has
  // been printed is not yet a URL that works.
  private async waitReachable(url: string, child: ChildProcess): Promise<void> {
    const deadline = Date.now() + REACHABLE_WAIT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("The tunnel closed while warming up.");
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (response.ok) return;
      } catch {
        // Edge not ready yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error("The tunnel came up but never became reachable.");
  }

  start(localPort: number): Promise<TunnelStatus> {
    if (this.state === "running") return Promise.resolve(this.status());
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart(localPort).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(localPort: number): Promise<TunnelStatus> {
    this.setState("starting");
    try {
      const bin = await this.ensureBinary();
      const session = await this.requestBrokerSession(localPort);
      const args = session
        ? ["tunnel", "--no-autoupdate", "run", "--token", session.tunnelToken]
        : ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${localPort}`];
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;
      this.session = session;
      this.mode = session ? "named" : "quick";
      if (session) {
        this.url = session.url;
        this.attachLog(child);
      } else {
        this.url = await this.captureUrl(child);
      }
      child.once("exit", () => {
        if (this.child === child) {
          this.child = null;
          this.setState("error", "The share tunnel closed unexpectedly.");
        }
      });
      await this.waitDns(new URL(this.url).hostname, child);
      await this.waitReachable(`${this.url}/api/health`, child);
      this.setState("running");
    } catch (err) {
      await this.stop().catch(() => undefined);
      this.setState("error", err instanceof Error ? err.message : String(err));
    }
    return this.status();
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.url = "";
    this.mode = "";
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
    await this.releaseBrokerSession();
    this.setState("stopped");
  }
}
