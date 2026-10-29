import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App, SafeStorage } from "electron";

// safeStorage keys every sealed sign-in by the app's internal name (the
// macOS Keychain's "<name> Safe Storage", the Linux secret service's
// application). Every release before 0.22.0 ran as open-dungeon-master-client:
// the packaged package.json has no productName, so Electron names the app
// after its "name". 0.22.0 alone ran as "Open Dungeon Master", found no key
// under that name, made a new one, and could open none of the sign-ins
// sealed before it: the device world's owner met a password form for a
// password only the shell knew (client issue 100).
//
// The app runs under the old name again (index.ts). What 0.22.0 sealed
// itself (a world first made on it, a sign-in made again on it) opens only
// under its key, and a process reads the key of the one name it had when it
// became ready. So the shell starts itself once more under 0.22.0's name, as
// a helper with no window that opens those values and hands them back on a
// pipe, and seals them again under its own key.
export const RENAMED_KEYCHAIN_NAME = "Open Dungeon Master";
export const UNSEAL_ARG = "--unseal-renamed-key";
// Marks the helper's one line of reply among anything else on its stdout.
const REPLY_MARK = "unsealed:";

export interface UnsealReply {
  // Whether the helper reached a key at all: false when the keychain was
  // refused or there is no keyring, and then nothing was tried.
  available: boolean;
  // In the order the ciphers were given; null for one its key cannot open.
  opened: (string | null)[];
}

export function isUnsealHelper(argv: readonly string[]): boolean {
  return argv.some((arg) => arg.startsWith(`${UNSEAL_ARG}=`));
}

// The helper's side, run instead of the app. Its folder (from the shell)
// holds the ciphers and becomes its own profile, so nothing it starts
// touches the shell's.
export function runUnsealHelper(app: App, safeStorage: SafeStorage, argv: readonly string[]): void {
  app.setName(RENAMED_KEYCHAIN_NAME);
  const dir = argv.find((arg) => arg.startsWith(`${UNSEAL_ARG}=`))?.slice(UNSEAL_ARG.length + 1) ?? "";
  if (!path.isAbsolute(dir)) {
    app.exit(1);
    return;
  }
  app.setPath("userData", path.join(dir, "profile"));
  app.dock?.hide();
  void app.whenReady().then(() => {
    let ciphers: unknown = [];
    try {
      ciphers = JSON.parse(fs.readFileSync(path.join(dir, "ciphers.json"), "utf8"));
    } catch {
      // Nothing to open.
    }
    const list = Array.isArray(ciphers) ? ciphers.filter((cipher): cipher is string => typeof cipher === "string") : [];
    const available = safeStorage.isEncryptionAvailable();
    const opened = list.map((cipher) => {
      if (!available) return null;
      try {
        return safeStorage.decryptString(Buffer.from(cipher, "base64"));
      } catch {
        return null;
      }
    });
    process.stdout.write(`${REPLY_MARK}${JSON.stringify({ available, opened })}\n`, () => app.exit(0));
  });
}

export function parseUnsealReply(stdout: string, count: number): UnsealReply | null {
  const line = stdout.split("\n").find((entry) => entry.startsWith(REPLY_MARK));
  if (!line) return null;
  try {
    const reply = JSON.parse(line.slice(REPLY_MARK.length)) as { available?: unknown; opened?: unknown };
    if (typeof reply.available !== "boolean" || !Array.isArray(reply.opened) || reply.opened.length !== count) return null;
    return {
      available: reply.available,
      opened: reply.opened.map((value: unknown) => (typeof value === "string" ? value : null)),
    };
  } catch {
    return null;
  }
}

// The shell's side: starts the helper the way the shell itself was started
// (a dev run's "electron <app>" passes the app's folder) and waits for its
// reply. A Mac may ask the player about the keychain first, hence the long
// wait; a helper that never answers gives null and is tried next start.
// --no-sandbox because the helper shows no page, and a launch that needs
// the flag (Steam's runtime) would otherwise fail it.
export async function unsealWithRenamedKey(
  ciphers: readonly string[],
  launch: { execPath: string; appPath: string | null },
  timeoutMs = 120_000,
): Promise<UnsealReply | null> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ogm-unseal-"));
  try {
    await fs.promises.writeFile(path.join(dir, "ciphers.json"), JSON.stringify(ciphers), { mode: 0o600 });
    const args = [...(launch.appPath ? [launch.appPath] : []), `${UNSEAL_ARG}=${dir}`, "--no-sandbox", "--disable-gpu"];
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const stdout = await new Promise<string | null>((resolve) => {
      const child = spawn(launch.execPath, args, { env, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      const timer = setTimeout(() => {
        child.kill();
        resolve(null);
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
      });
      child.once("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.once("close", () => {
        clearTimeout(timer);
        resolve(out);
      });
    });
    return stdout === null ? null : parseUnsealReply(stdout, ciphers.length);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface RenamedKeyStore {
  unopened(): string[];
  reseal(opened: ReadonlyMap<string, string>): number;
  renamedKeyTried(): boolean;
  markRenamedKeyTried(): void;
}

// Once per install, and only when this run's key cannot open something.
// The helper reaching a key marks the job done, whatever it opened (a value
// no key opens is not tried again every start); a helper that was refused
// the keychain, or never answered, is tried again next start. Returns how
// many values were sealed again.
export async function recoverRenamedSeals(
  store: RenamedKeyStore,
  unseal: (ciphers: string[]) => Promise<UnsealReply | null>,
): Promise<number> {
  if (store.renamedKeyTried()) return 0;
  const ciphers = store.unopened();
  if (ciphers.length === 0) return 0;
  const reply = await unseal(ciphers);
  if (!reply?.available) return 0;
  const opened = new Map<string, string>();
  reply.opened.forEach((plain, index) => {
    if (plain !== null) opened.set(ciphers[index]!, plain);
  });
  const count = store.reseal(opened);
  store.markRenamedKeyTried();
  return count;
}
