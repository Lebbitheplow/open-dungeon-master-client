import { contextBridge, ipcRenderer } from "electron";
import type { ShellShareStatus } from "../shared/types";

// Preload for connected servers' pages. Deliberately small: the page is
// someone else's web app, so it gets no bridge into the shell beyond one
// door back to the server list and, for the shell's own world, the switch
// that shares it on the internet from the lobby's invite dialog. Same
// contract as the Android shell hook in mobile/src/shell-hook.ts; the
// server's src/lib/shell-host.ts is the consumer.
contextBridge.exposeInMainWorld("odmShell", {
  platform: "desktop",
  showServers: () => ipcRenderer.send("shell:show-servers"),
  share: {
    status: () => ipcRenderer.invoke("shell:share-status"),
    start: () => ipcRenderer.invoke("shell:share-start"),
    stop: () => ipcRenderer.invoke("shell:share-stop"),
    subscribe: (listener: (status: ShellShareStatus) => void) => {
      const handler = (_event: unknown, status: ShellShareStatus): void => listener(status);
      ipcRenderer.on("odm:share-status", handler);
      return () => ipcRenderer.removeListener("odm:share-status", handler);
    },
  },
});
