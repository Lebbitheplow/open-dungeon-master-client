import { contextBridge, ipcRenderer } from "electron";

// Preload for connected servers' pages. Deliberately tiny: the page is
// someone else's web app, so it gets no bridge into the shell beyond one
// door back to the server list. The server's account menu shows a "Switch
// server" entry when window.odmShell exists (same contract as the Android
// shell hook in mobile/src/shell-hook.ts).
contextBridge.exposeInMainWorld("odmShell", {
  platform: "desktop",
  showServers: () => ipcRenderer.send("shell:show-servers"),
});
