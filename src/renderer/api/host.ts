// The shell's own screens talk to a host's API from here: JSON calls and
// file fetches with the host's bearer token, and the campaign event
// stream read through fetch (EventSource cannot carry a header) with
// reconnection on the last event id. One client per host session; the
// origin and token come from the bridge (window.odm.hostSession), never
// from a page.
import { createSseParser, type SseEvent } from "../../shared/sse.js";

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
  // URL for an <img> or <audio>; the caller revokes it when done.
  async objectUrl(path: string): Promise<string> {
    const res = await fetch(`${this.origin}${path}`, { headers: this.headers() });
    if (!res.ok) throw new HostError(`${this.origin} answered ${res.status}.`, res.status);
    return URL.createObjectURL(await res.blob());
  }

  // The campaign's event stream. Reconnects with the last event id after a
  // drop, backing off; close() ends it for good. onState reports whether
  // the stream is currently open, for a "reconnecting" hint.
  stream(
    path: string,
    onEvent: (event: SseEvent) => void,
    onState?: (open: boolean) => void,
  ): StreamHandle {
    const controller = new AbortController();
    let closed = false;
    let attempt = 0;
    let lastId = "";
    const parser = createSseParser((event) => {
      lastId = event.id || lastId;
      onEvent(event);
    });

    const connect = async (): Promise<void> => {
      while (!closed) {
        try {
          const res = await fetch(`${this.origin}${path}`, {
            headers: this.headers({
              accept: "text/event-stream",
              ...(lastId ? { "last-event-id": lastId } : {}),
            }),
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
            onState?.(false);
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
