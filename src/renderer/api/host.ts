// The shell's own screens talk to a host's API from here: JSON calls and
// file fetches with the host's bearer token, and the campaign event
// stream read through fetch (EventSource cannot carry a header) with
// reconnection on the last event id. One client per host session; the
// origin and token come from the bridge (window.odm.hostSession), never
// from a page.
import { createSseParser, type SseEvent, streamRequestHeaders } from "../../shared/sse.js";

export class HostError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface HostSession {
  origin: string;
  token: string;
}

export interface StreamHandle {
  close(): void;
}

// Why a stream ended for good: the host refused the session (401 or 403),
// which no reconnect will mend. Surfaced so the page can say so.
export interface StreamStop {
  permanent: true;
  status: number;
  reason: "unauthorized";
}

const RECONNECT_MS = [1000, 2000, 5000, 10000];

export class HostClient {
  constructor(readonly session: HostSession) {}

  get origin(): string {
    return this.session.origin;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.session.token}`, "x-odm-client": "shell", ...extra };
  }

  // A JSON call. Non-2xx answers throw a HostError carrying the server's
  // own message where it gave one.
  async json<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.origin}${path}`, {
        method: init.method ?? "GET",
        headers: this.headers(init.body !== undefined ? { "content-type": "application/json" } : {}),
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch {
      throw new HostError(`Could not reach ${this.origin}.`, 0);
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const message = (body as { error?: unknown } | null)?.error;
      throw new HostError(
        typeof message === "string" && message ? message : `${this.origin} answered ${res.status}.`,
        res.status,
      );
    }
    return body as T;
  }

  // A file behind the host's login (uploads, generated art) as an object
  // URL for an <img> or <audio>, with its size so a cache can budget bytes;
  // the caller revokes it when done. The path may carry a query (a sized
  // variant such as "?w=256"); it goes to the host untouched.
  async blobUrl(path: string): Promise<{ url: string; bytes: number }> {
    // cache: "reload" goes to the network and replaces whatever the WebView
    // had stored. The same picture may already sit in its HTTP cache from a
    // request that carried no Origin (the web view fallback shows the host's
    // own page, where a picture is same-origin), so that copy has no
    // Access-Control-Allow-Origin. A host behind Cloudflare loses its
    // "Vary: Origin" on the way, the cache then answers this cross-origin
    // fetch with the header-less copy, and the fetch is blocked by CORS.
    // Generated pictures are served "immutable" for a year, so without this
    // they stayed broken in the apps for a year. The object URL cache above
    // this call keeps one download per picture per app session.
    const res = await fetch(`${this.origin}${path}`, { headers: this.headers(), cache: "reload" });
    if (!res.ok) throw new HostError(`${this.origin} answered ${res.status}.`, res.status);
    const blob = await res.blob();
    return { url: URL.createObjectURL(blob), bytes: blob.size };
  }

  async objectUrl(path: string): Promise<string> {
    return (await this.blobUrl(path)).url;
  }

  // The campaign's event stream. Reconnects with the last event id after a
  // drop, backing off; close() ends it for good. onState reports whether
  // the stream is currently open, for a "reconnecting" hint; a stop that
  // retrying cannot mend (the session refused) comes with `permanent`.
  stream(
    path: string,
    onEvent: (event: SseEvent) => void,
    onState?: (open: boolean, stop?: StreamStop) => void,
  ): StreamHandle {
    const controller = new AbortController();
    let closed = false;
    let attempt = 0;
    let lastId = "";

    const connect = async (): Promise<void> => {
      while (!closed) {
        // A parser per connection: a drop mid-event would otherwise leave
        // half a line in the buffer, and the first replayed event after the
        // reconnect would be glued to it and fail to parse. The last id
        // outlives the parser so the replay starts where the drop was.
        const parser = createSseParser((event) => {
          lastId = event.id || lastId;
          onEvent(event);
        });
        try {
          const res = await fetch(`${this.origin}${path}`, {
            headers: this.headers(streamRequestHeaders(lastId)),
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw new HostError(`${res.status}`, res.status);
          attempt = 0;
          onState?.(true);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            parser.feed(decoder.decode(value, { stream: true }));
          }
        } catch (err) {
          if (closed) return;
          // A revoked session will not come back by retrying.
          if (err instanceof HostError && (err.status === 401 || err.status === 403)) {
            closed = true;
            onState?.(false, { permanent: true, status: err.status, reason: "unauthorized" });
            return;
          }
        }
        if (closed) return;
        onState?.(false);
        const delay = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)] ?? 10000;
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    };
    void connect();

    return {
      close() {
        closed = true;
        controller.abort();
      },
    };
  }
}

// The client for a host the shell knows, or null when it has no live
// session there (the caller then offers a sign-in).
export async function hostClient(hostId: string): Promise<HostClient | null> {
  const session = await window.odm.hostSession(hostId);
  return session ? new HostClient(session) : null;
}
