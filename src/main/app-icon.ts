import path from "node:path";
import { app } from "electron";

// The d20 logo for every window, the taskbar and the dock. Packaged builds
// ship it as an extra resource (electron-builder.yml); a dev run reads it
// from build/, where scripts/make-icons.mjs renders it from build/icon.svg.
export function appIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(__dirname, "../../build/icon.png");
}
