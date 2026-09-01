import path from "node:path";
import { BrowserWindow, Menu, WebContentsView, session, shell } from "electron";
import type { ShellEvent } from "../shared/types";

// One window. Its own page is the shell UI (server picker, login, wizard);
// a connected server's web app renders in a WebContentsView layered on top,
// in that server's partition, with no preload and no bridge. Ctrl+M (or the
// View menu) drops back to the shell.

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function openExternally(url: string): void {
  if (url.startsWith("https:") || url.startsWith("http:")) void shell.openExternal(url);
}

// Server pages get microphone (voice chat), notifications (session
// reminders and turn alerts), clipboard and fullscreen, and nothing else.
// Requests from any other origin are denied outright.
function hardenPartition(partition: string, origin: string): void {
  const allowed = new Set([
    "media",
    "notifications",
    "clipboard-sanitized-write",
    "fullscreen",
    "pointerLock",
  ]);
  session.fromPartition(partition).setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowed.has(permission) && details.requestingUrl.startsWith(origin));
  });
}

export class ShellWindow {
  private win: BrowserWindow | null = null;
  private view: WebContentsView | null = null;
  private currentOrigin = "";

  create(): void {
    this.win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      backgroundColor: "#181420",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "../preload/index.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const contents = this.win.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      openExternally(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event) => event.preventDefault());
    this.win.on("resize", () => this.layout());
    this.win.on("closed", () => {
      this.win = null;
      this.view = null;
    });
    Menu.setApplicationMenu(this.buildMenu());
    void this.win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  private buildMenu(): Menu {
    return Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [{ role: "quit" }],
      },
      {
        label: "View",
        submenu: [
          {
            label: "Servers",
            accelerator: "CmdOrCtrl+M",
            click: () => this.showManager(),
          },
          { type: "separator" },
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
    ]);
  }

  focus(): void {
    if (!this.win) return;
    if (this.win.isMinimized()) this.win.restore();
    this.win.focus();
  }

  whenPageReady(): Promise<void> {
    const contents = this.win?.webContents;
    if (!contents || !contents.isLoading()) return Promise.resolve();
    return new Promise((resolve) => contents.once("did-finish-load", () => resolve()));
  }

  sendEvent(event: ShellEvent): void {
    this.win?.webContents.send("odm:event", event);
  }

  private layout(): void {
    if (!this.win || !this.view) return;
    const [width, height] = this.win.getContentSize();
    this.view.setBounds({ x: 0, y: 0, width: width ?? 0, height: height ?? 0 });
  }

  attachView(origin: string, partition: string, pathname: string): void {
    if (!this.win) return;
    this.detachView();
    hardenPartition(partition, origin);
    const view = new WebContentsView({
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.view = view;
    this.currentOrigin = origin;
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (sameOrigin(url, origin)) {
        void view.webContents.loadURL(url);
      } else {
        openExternally(url);
      }
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, url) => {
      if (!sameOrigin(url, origin)) {
        event.preventDefault();
        openExternally(url);
      }
    });
    this.win.contentView.addChildView(view);
    this.layout();
    void view.webContents.loadURL(`${origin}${pathname}`);
  }

  private detachView(): void {
    if (!this.win || !this.view) return;
    this.win.contentView.removeChildView(this.view);
    this.view.webContents.close();
    this.view = null;
    this.currentOrigin = "";
  }

  showManager(): void {
    if (!this.view) return;
    this.detachView();
    this.sendEvent({ kind: "show-manager" });
  }
}
