import { contextBridge, ipcRenderer } from "electron";
import type { AiSetup, OdmBridge, ShellEvent } from "../shared/types";

// The whole bridge is invoke-shaped: the renderer can ask, never reach into
// Node. This preload only ever loads for the shell's own UI, not for
// connected servers' pages, which run in separate partitions with no bridge.

const bridge: OdmBridge = {
  listServers: () => ipcRenderer.invoke("servers:list"),
  probeServer: (origin: string) => ipcRenderer.invoke("servers:probe", origin),
  login: (input) => ipcRenderer.invoke("servers:login", input),
  register: (input) => ipcRenderer.invoke("servers:register", input),
  connect: (serverId: string, joinCode?: string) =>
    ipcRenderer.invoke("servers:connect", serverId, joinCode),
  removeServer: (serverId: string) => ipcRenderer.invoke("servers:remove", serverId),
  localStart: () => ipcRenderer.invoke("local:start"),
  localCreateAccount: (input) => ipcRenderer.invoke("local:create-account", input),
  localLogin: (input) => ipcRenderer.invoke("local:login", input),
  localConfigureAi: (setup: AiSetup) => ipcRenderer.invoke("local:configure-ai", setup),
  localPlay: (joinCode?: string) => ipcRenderer.invoke("local:play", joinCode),
  onEvent: (listener) => {
    ipcRenderer.on("odm:event", (_event, payload: ShellEvent) => listener(payload));
  },
};

contextBridge.exposeInMainWorld("odm", bridge);
