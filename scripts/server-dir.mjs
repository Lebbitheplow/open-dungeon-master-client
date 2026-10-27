// The server checkout the client builds against: ODM_SERVER_DIR, else the
// sibling folder a clone makes (open-game-master), else the one a clone made
// before the repository was renamed (open-dungeon-master).
import fs from "node:fs";
import path from "node:path";

export function serverDir(repo) {
  if (process.env.ODM_SERVER_DIR) return path.resolve(process.env.ODM_SERVER_DIR);
  const sibling = (name) => path.resolve(repo, "..", name);
  const legacy = sibling("open-dungeon-master");
  return !fs.existsSync(sibling("open-game-master")) && fs.existsSync(legacy) ? legacy : sibling("open-game-master");
}
