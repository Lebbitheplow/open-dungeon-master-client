// Parsing for odm:// deep links and server origins. Pure functions with no
// Electron imports, so tests load this module under plain Node.

// Campaign room codes use the server's unambiguous invite alphabet
// (no 0/O/1/I), 4 to 12 characters.
export const CODE_SHAPE = /^[A-HJ-NP-Z2-9]{4,12}$/;

// Turns pasted input into a clean http(s) origin, or null. Re-serializing
// through URL strips userinfo tricks like https://good.com@evil.com.
export function normalizeOrigin(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 300) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  return url.origin;
}

// People paste addresses without a scheme ("play.example.com",
// "192.168.1.50:3005"). Offer https first, then http, so LAN servers on
// plain http still connect; explicit schemes are taken as-is.
export function originCandidates(raw: string): string[] {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length === 0 || trimmed.length > 300) return [];
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    const origin = normalizeOrigin(trimmed);
    return origin ? [origin] : [];
  }
  const candidates: string[] = [];
  for (const scheme of ["https", "http"]) {
    const origin = normalizeOrigin(`${scheme}://${trimmed}`);
    if (origin) candidates.push(origin);
  }
  return candidates;
}

export interface JoinLink {
  origin: string;
  code: string;
}

// odm://join?s=<server origin>&c=<CODE>, the shape the /j Worker hands out.
export function parseJoinLink(raw: string): JoinLink | null {
  if (typeof raw !== "string" || raw.length > 700) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "odm:") return null;
  const action = url.host || (url.pathname.replace(/^\/+/, "").split("/")[0] ?? "");
  if (action !== "join") return null;
  const origin = normalizeOrigin(url.searchParams.get("s") ?? "");
  const code = (url.searchParams.get("c") ?? "").trim().toUpperCase();
  if (!origin || !CODE_SHAPE.test(code)) return null;
  return { origin, code };
}

// Any invite shape a person might paste, scan, or open: the odm:// link, the
// https interstitial link the QR codes carry
// (https://opendungeonmaster.com/j?s=...&c=CODE, also /j/CODE?s=...), or a
// server's own readable join link (https://host/join/CODE), which is the one
// people see printed next to the room code.
export function parseAnyLink(raw: string): JoinLink | null {
  const direct = parseJoinLink(raw);
  if (direct) return direct;
  if (typeof raw !== "string" || raw.length > 700) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol === "https:" && url.host === "opendungeonmaster.com") {
    if (!url.pathname.startsWith("/j")) return null;
    const origin = normalizeOrigin(url.searchParams.get("s") ?? "");
    const code = (url.searchParams.get("c") ?? url.pathname.split("/")[2] ?? "")
      .trim()
      .toUpperCase();
    if (!origin || !CODE_SHAPE.test(code)) return null;
    return { origin, code };
  }
  const joined = /^\/join\/([^/]+)\/?$/.exec(url.pathname);
  if (!joined) return null;
  const origin = normalizeOrigin(url.href);
  const code = decodeURIComponent(joined[1] ?? "").trim().toUpperCase();
  if (!origin || !CODE_SHAPE.test(code)) return null;
  return { origin, code };
}

// A bare server address, the shape the server's own floating QR button
// encodes (its origin, nothing else): scanning one means "add this server",
// with no campaign to join. Only http(s) with no path to speak of counts, so
// a join link never reads as a server address by accident; the invite shapes
// above are tried first by every caller.
export function parseServerAddress(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > 300) return null;
  const origin = normalizeOrigin(raw);
  if (!origin) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.search || url.hash) return null;
  return origin;
}

// Picks the odm:// link out of a process argv, if one is present.
export function joinLinkFromArgv(argv: readonly string[]): JoinLink | null {
  for (const arg of argv) {
    if (typeof arg === "string" && arg.startsWith("odm://")) {
      const parsed = parseJoinLink(arg);
      if (parsed) return parsed;
    }
  }
  return null;
}
