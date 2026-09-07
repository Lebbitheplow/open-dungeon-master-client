// The room code a player types is the campaign's own invite code. It never
// changes. The address its host answers at changes with every share
// session, so the broker keeps the join between the two: while a world is
// shared, this publishes "code X is at Y right now", and a joining app
// reads it back. That is what lets one short code keep working, and what
// keeps a player from collecting a list of dead addresses.
//
// Publishing is best effort throughout. A world that cannot reach the
// broker is still perfectly playable over its link and its QR code.
import { DEFAULT_BROKER_URL, parseTableReply, tableEndpoint } from "../shared/broker";
import { CODE_SHAPE } from "../shared/deep-link";

const TIMEOUT_MS = 8000;

function brokerBase(): string {
  return process.env.ODM_BROKER_URL || DEFAULT_BROKER_URL;
}

async function send(url: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return null;
  }
}

// Every room code on this world that the signed-in account owns. Only an
// owner's codes are published: claiming a table you merely play at would
// point someone else's code at your machine.
export async function ownedTableCodes(origin: string, token: string): Promise<string[]> {
  const response = await send(`${origin}/api/campaigns`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response?.ok) return [];
  const body = (await response.json().catch(() => null)) as { campaigns?: unknown } | null;
  if (!Array.isArray(body?.campaigns)) return [];
  const codes: string[] = [];
  for (const raw of body.campaigns) {
    const entry = raw as { inviteCode?: unknown; role?: unknown } | null;
    if (!entry || entry.role !== "owner") continue;
    const code = String(entry.inviteCode ?? "").trim().toUpperCase();
    if (CODE_SHAPE.test(code) && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

// Points each code at the address the world is reachable at now.
export async function publishTables(input: {
  codes: readonly string[];
  url: string;
  secretFor: (code: string) => string;
}): Promise<string[]> {
  const published: string[] = [];
  for (const code of input.codes) {
    const response = await send(tableEndpoint(brokerBase(), code), {
      method: "PUT",
      headers: { "content-type": "application/json", "x-table-secret": input.secretFor(code) },
      body: JSON.stringify({ url: input.url }),
    });
    if (response?.ok) published.push(code);
  }
  return published;
}

// Sharing stopped: a friend who types the code is told the table is
// offline rather than sent to an address nothing answers at. The claim
// itself survives for next session.
export async function dropTables(input: {
  codes: readonly string[];
  secretFor: (code: string) => string;
}): Promise<void> {
  for (const code of input.codes) {
    await send(tableEndpoint(brokerBase(), code), {
      method: "DELETE",
      headers: { "x-table-secret": input.secretFor(code) },
    });
  }
}

// Where a table is right now, or "" when no host has it online.
export async function resolveTable(code: string): Promise<string> {
  const response = await send(tableEndpoint(brokerBase(), code), { method: "GET" });
  if (!response?.ok) return "";
  return parseTableReply(await response.json().catch(() => null));
}
