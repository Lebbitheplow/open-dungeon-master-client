// The tunnel broker's contract, shared by the desktop shell (src/main/tunnel.ts)
// and the Android bridge (mobile/src/share-tunnel.ts). The broker is a
// Cloudflare Worker (workers/tunnel-broker in the server repo) that mints a
// named tunnel with a play-CODE.opendungeonmaster.com hostname; when it
// cannot help (offline, rate limited, not configured) hosting falls back to
// an anonymous quick tunnel on trycloudflare.com.

export const DEFAULT_BROKER_URL = "https://odm-tunnel-broker.tunnel-broker.workers.dev";

// Named sessions from the default broker are play-CODE one label under the
// official zone (one level so the free Universal SSL wildcard covers them);
// a broker that hands back anything else does not get its hostname shown to
// the user or written into the server's publicUrl.
const BROKER_HOST_SHAPE = /^play-[a-z0-9]+\.opendungeonmaster\.com$/;
const HOSTNAME_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// What a quick tunnel prints once the edge has assigned it an address.
export const QUICK_URL_SHAPE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export interface BrokerSession {
  code: string;
  url: string;
  hostname: string;
  tunnelToken: string;
  secret: string;
}

// The hostname becomes the user's share link and the server's publicUrl, so
// a broker reply is not taken on faith: it must be a plain DNS name, and
// sessions from the default broker must sit under the official play domain.
// A custom broker (requireOfficialSuffix false) may use its own domain.
export function parseBrokerSession(
  body: unknown,
  requireOfficialSuffix: boolean,
): BrokerSession | null {
  const raw = body as Partial<BrokerSession> | null;
  if (!raw?.tunnelToken || !raw?.hostname || !raw?.code || !raw?.secret) return null;
  const hostname = String(raw.hostname).toLowerCase();
  if (!HOSTNAME_SHAPE.test(hostname)) return null;
  if (requireOfficialSuffix && !BROKER_HOST_SHAPE.test(hostname)) return null;
  return {
    code: String(raw.code),
    url: `https://${hostname}`,
    hostname,
    tunnelToken: String(raw.tunnelToken),
    secret: String(raw.secret),
  };
}
