import { contextBridge, ipcRenderer } from "electron";
import type { AiSetup, OdmBridge, ShellEvent } from "../shared/types";

// The whole bridge is invoke-shaped: the renderer can ask, never reach into
// Node. This preload only ever loads for the shell's own UI, not for
// connected servers' pages, which run in separate partitions with no bridge.

const bridge: OdmBridge = {
  platform: "desktop",
  listServers: () => ipcRenderer.invoke("servers:list"),
  probeServer: (origin: string) => ipcRenderer.invoke("servers:probe", origin),
  login: (input) => ipcRenderer.invoke("servers:login", input),
  register: (input) => ipcRenderer.invoke("servers:register", input),
  discordLogin: (input) => ipcRenderer.invoke("servers:discord-login", input),
  connect: (serverId: string, joinCode?: string, path?: string) =>
    ipcRenderer.invoke("servers:connect", serverId, joinCode, path),
  removeServer: (serverId: string) => ipcRenderer.invoke("servers:remove", serverId),
  deleteAccount: (input) => ipcRenderer.invoke("servers:delete-account", input),
  homeFeed: () => ipcRenderer.invoke("home:feed"),
  homeFeedCached: () => ipcRenderer.invoke("home:feed-cached"),
  openInviteLink: (raw: string) => ipcRenderer.invoke("servers:open-invite", raw),
  localStart: () => ipcRenderer.invoke("local:start"),
  localCreateAccount: (input) => ipcRenderer.invoke("local:create-account", input),
  localLogin: (input) => ipcRenderer.invoke("local:login", input),
  localConfigureAi: (setup: AiSetup) => ipcRenderer.invoke("local:configure-ai", setup),
  localPlay: (joinCode?: string, path?: string) =>
    ipcRenderer.invoke("local:play", joinCode, path),
  shareStart: () => ipcRenderer.invoke("share:start"),
  shareStop: () => ipcRenderer.invoke("share:stop"),
  localAiScan: () => ipcRenderer.invoke("local-ai:scan"),
  localAiInstall: (tierId: string) => ipcRenderer.invoke("local-ai:install", tierId),
  localAiInstallComfy: () => ipcRenderer.invoke("local-ai:install-comfy"),
  localAiUninstall: (component: "text" | "images") =>
    ipcRenderer.invoke("local-ai:uninstall", component),
  localAiStatus: () => ipcRenderer.invoke("local-ai:status"),
  appInfo: () => ipcRenderer.invoke("app:info"),
  updateCheck: () => ipcRenderer.invoke("update:check"),
  updateInstall: () => ipcRenderer.invoke("update:install"),
  onEvent: (listener) => {
    ipcRenderer.on("odm:event", (_event, payload: ShellEvent) => listener(payload));
  },
};

contextBridge.exposeInMainWorld("odm", bridge);
