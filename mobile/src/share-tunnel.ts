import {
  DEFAULT_BROKER_URL,
  parseBrokerSession,
  type BrokerSession,
} from "../../src/shared/broker";
import type { ShellEvent, TunnelStatus } from "../../src/shared/types";

// Sharing the device-hosted world on the internet, the Android counterpart
// of the desktop shell's QuickTunnel (src/main/tunnel.ts) with the same
// order of preference: a named play-CODE session from the broker, falling
// back to an anonymous quick tunnel when the broker cannot help or its
// tunnel never comes up. cloudflared itself runs natively (ShareTunnel.java,
// reached through the LocalWorld plugin); this module decides, waits for
// the address to resolve and answer, and keeps the server's publicUrl true.

const REACHABLE_WAIT_MS = 90_000;
const POLL_MS = 1500;

export interface SharePluginStatus {
  available: boolean;
  running: boolean;
  url: string;
  mode: string;
}

export interface SharePlugin {
  shareStatus(): Promise<SharePluginStatus>;
  // With a token: a named tunnel whose address is url. Without: a quick
  // tunnel, whose address comes back once cloudflared reports it.
  shareStart(options: { token?: string; url?: string; port: number }): Promise<{ url: string }>;
  shareStop(): Promise<unknown>;
}

export interface JsonReply {
  status: number;
  data: unknown;
}

export interface ShareTunnelDeps {
  plugin: SharePlugin;
  // Native HTTP (no CORS wall): JSON in, JSON out, never throws on a bad
  // status, only on no reply at all.
  fetchJson(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number },
  ): Promise<JsonReply>;
  // "" means the official broker.
  brokerUrl(): string;
  // Makes sure the world runs and returns its local port.
  worldPort(): Promise<number>;
  // Tells the world where it is reachable ("" when the share ended) so
  // invite links and QR codes inside the game point at it.
  publish(url: string): Promise<void>;
  emit(event: ShellEvent): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : "Sharing failed." };
}

export function createShareTunnel(deps: ShareTunnelDeps) {
  let state: TunnelStatus["state"] = "stopped";
  let url = "";
  let mode: TunnelStatus["mode"] = "";
  let error = "";
  let session: BrokerSession | null = null;
  let stopRequested = false;
  let inFlight: Promise<TunnelStatus> | null = null;

  function snapshot(): TunnelStatus {
    return {
      state,
      url: state === "running" ? url : "",
      mode: state === "running" ? mode : "",
      error,
    };
  }

  function setState(next: TunnelStatus["state"], message = ""): void {
    state = next;
    error = message;
    deps.emit({ kind: "tunnel-status", status: snapshot() });
  }

  function brokerBase(): string {
    return deps.brokerUrl() || DEFAULT_BROKER_URL;
  }

  async function requestSession(port: number): Promise<BrokerSession | null> {
    try {
      const reply = await deps.fetchJson(`${brokerBase()}/session`, {
        method: "POST",
        body: { port },
        timeoutMs: 15_000,
      });
      if (reply.status < 200 || reply.status >= 300) return null;
      return parseBrokerSession(reply.data, !deps.brokerUrl());
    } catch {
      return null;
    }
  }

  async function releaseSession(): Promise<void> {
    const current = session;
    session = null;
    if (!current) return;
    await deps
      .fetchJson(`${brokerBase()}/session/${current.code}`, {
        method: "DELETE",
        headers: { "x-session-secret": current.secret },
        timeoutMs: 10_000,
      })
      .catch(() => undefined);
  }

  async function stillUp(): Promise<boolean> {
    const status = await deps.plugin.shareStatus().catch(() => null);
    return !!status?.running;
  }

  // A fresh hostname takes a few seconds to appear in DNS. Confirmed over
  // DNS-over-HTTPS first so the device's own resolver never caches a miss.
  async function waitDns(host: string): Promise<void> {
    const deadline = deps.now() + REACHABLE_WAIT_MS;
    while (deps.now() < deadline) {
      if (stopRequested) throw new Error("stopped");
      if (!(await stillUp())) throw new Error("The tunnel closed while warming up.");
      try {
        const reply = await deps.fetchJson(
          `https://cloudflare-dns.com/dns-query?name=${host}&type=A`,
          { headers: { accept: "application/dns-json" }, timeoutMs: 4000 },
        );
        const body = reply.data as { Answer?: unknown[] } | null;
        if (Array.isArray(body?.Answer) && body.Answer.length > 0) return;
      } catch {
        // DoH hiccup; keep waiting.
      }
      await deps.sleep(POLL_MS);
    }
    throw new Error("The tunnel's address never appeared in DNS.");
  }

  // The edge needs a moment to route a fresh tunnel; an address that exists
  // is not yet an address that works.
  async function waitReachable(base: string): Promise<void> {
    const deadline = deps.now() + REACHABLE_WAIT_MS;
    while (deps.now() < deadline) {
      if (stopRequested) throw new Error("stopped");
      if (!(await stillUp())) throw new Error("The tunnel closed while warming up.");
      try {
        const reply = await deps.fetchJson(`${base}/api/health`, { timeoutMs: 4000 });
        if (reply.status >= 200 && reply.status < 300) return;
      } catch {
        // Edge not ready yet.
      }
      await deps.sleep(POLL_MS);
    }
    throw new Error("The tunnel came up but never became reachable.");
  }

  async function launch(port: number, named: BrokerSession | null): Promise<void> {
    if (named) {
      await deps.plugin.shareStart({ token: named.tunnelToken, url: named.url, port });
      url = named.url;
      mode = "named";
    } else {
      const started = await deps.plugin.shareStart({ port });
      if (!started?.url) throw new Error("The tunnel never reported its address.");
      url = started.url;
      mode = "quick";
    }
    session = named;
    await waitDns(new URL(url).hostname);
    await waitReachable(url);
  }

  async function tearDown(): Promise<void> {
    await deps.plugin.shareStop().catch(() => undefined);
    await releaseSession();
    url = "";
    mode = "";
  }

  async function doStart(): Promise<TunnelStatus> {
    stopRequested = false;
    setState("starting");
    try {
      const port = await deps.worldPort();
      const named = await requestSession(port);
      let up = false;
      if (named) {
        try {
          await launch(port, named);
          up = true;
        } catch (err) {
          if (stopRequested) throw err;
          // The broker answered but its tunnel never came up (bad token,
          // stuck DNS, edge trouble). A quick tunnel beats an error.
          await tearDown();
        }
      }
      if (!up) await launch(port, null);
      await deps.publish(url);
      setState("running");
    } catch (err) {
      const requested = stopRequested;
      await tearDown();
      await deps.publish("").catch(() => undefined);
      setState(requested ? "stopped" : "error", requested ? "" : fail(err).error);
    }
    return snapshot();
  }

  function start(): Promise<TunnelStatus> {
    if (state === "running") return Promise.resolve(snapshot());
    if (inFlight) return inFlight;
    inFlight = doStart().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function stop(): Promise<TunnelStatus> {
    stopRequested = true;
    if (inFlight) await inFlight.catch(() => undefined);
    await tearDown();
    await deps.publish("").catch(() => undefined);
    setState("stopped");
    return snapshot();
  }

  // The notification's "Stop hosting" ends the tunnel natively; this side
  // learns of it on the next look and settles the leftovers.
  async function status(): Promise<TunnelStatus> {
    if (state === "running" && !(await stillUp())) {
      await releaseSession();
      url = "";
      mode = "";
      await deps.publish("").catch(() => undefined);
      setState("stopped");
    }
    return snapshot();
  }

  return { start, stop, status, snapshot };
}
