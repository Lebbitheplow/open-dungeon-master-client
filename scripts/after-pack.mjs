// electron-builder afterPack: a Linux build carries its program's name from
// before the rename to Open Game Master as a link to the program. A tar.gz
// from before the rename unpacks the new build over itself and restarts its
// own path (src/main/updater.ts unpackOver), which is that name.
import fs from "node:fs";
import path from "node:path";

const LEGACY_PROGRAM = "open-dungeon-master-client";

export default async function afterPack(context) {
  if (context.electronPlatformName !== "linux") return;
  const program = context.packager.executableName;
  if (program === LEGACY_PROGRAM) return;
  const link = path.join(context.appOutDir, LEGACY_PROGRAM);
  fs.rmSync(link, { force: true });
  fs.symlinkSync(program, link);
}
