import { session } from "electron";

// Each server gets its own persistent partition so cookies, storage and
// permissions never leak between servers.
export function partitionFor(serverId: string): string {
  return `persist:odm-${serverId}`;
}

// Turns the shell's bearer token into the odm_session cookie the server's
// web UI expects. Cookies are origin-scoped but the token is not, so this is
// re-applied on every connect; a changed local port just means a fresh set.
export async function applySessionCookie(
  partition: string,
  origin: string,
  token: string,
  expiresAt: string,
): Promise<void> {
  const expiry = Date.parse(expiresAt);
  await session.fromPartition(partition).cookies.set({
    url: origin,
    name: "odm_session",
    value: token,
    path: "/",
    httpOnly: true,
    secure: origin.startsWith("https:"),
    sameSite: "lax",
    ...(Number.isFinite(expiry) ? { expirationDate: expiry / 1000 } : {}),
  });
}

export async function clearPartition(partition: string): Promise<void> {
  await session.fromPartition(partition).clearStorageData();
}
