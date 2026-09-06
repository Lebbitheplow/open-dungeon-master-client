// The native game screens' own history: which host page is showing, as a
// path and query, with a back stack. Pure, so the tests can drive it; the
// renderer's Next.js navigation shims read and write it, the shell's back
// gesture pops it, and the route table turns the path into a page.

export interface GameLocation {
  pathname: string;
  search: string;
}

type Listener = () => void;

function split(url: string): GameLocation {
  const hash = url.indexOf("#");
  const clean = hash >= 0 ? url.slice(0, hash) : url;
  const query = clean.indexOf("?");
  return query >= 0
    ? { pathname: clean.slice(0, query) || "/", search: clean.slice(query) }
    : { pathname: clean || "/", search: "" };
}

export function isAbsoluteUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url);
}

export class GameRouter {
  private stack: GameLocation[];
  private readonly listeners = new Set<Listener>();
  // Addresses the native screens cannot show (another site, or the host by
  // full address): handed here for the shell to open the old way.
  onLeave: ((url: string) => void) | null = null;

  constructor(initial: string) {
    this.stack = [split(initial)];
  }

  get location(): GameLocation {
    return this.stack[this.stack.length - 1] ?? { pathname: "/", search: "" };
  }

  get depth(): number {
    return this.stack.length;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  push(url: string): void {
    if (isAbsoluteUrl(url)) {
      this.onLeave?.(url);
      return;
    }
    this.stack.push(split(url));
    this.notify();
  }

  replace(url: string): void {
    if (isAbsoluteUrl(url)) {
      this.onLeave?.(url);
      return;
    }
    this.stack[this.stack.length - 1] = split(url);
    this.notify();
  }

  back(): boolean {
    if (this.stack.length <= 1) return false;
    this.stack.pop();
    this.notify();
    return true;
  }

  // A fresh location object for the same address remounts the page, which
  // reloads its data the way a browser refresh would.
  refresh(): void {
    this.stack[this.stack.length - 1] = { ...this.location };
    this.notify();
  }
}

// Matches "/campaigns/:campaignId" style patterns against a path and
// returns the params, or null. One path piece per segment.
export function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split("/").filter(Boolean);
  const have = pathname.split("/").filter(Boolean);
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const piece = want[i] ?? "";
    const value = have[i] ?? "";
    if (piece.startsWith(":")) {
      try {
        params[piece.slice(1)] = decodeURIComponent(value);
      } catch {
        params[piece.slice(1)] = value;
      }
    } else if (piece !== value) {
      return null;
    }
  }
  return params;
}
