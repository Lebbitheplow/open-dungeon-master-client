import path from "node:path";
import { BrowserWindow, Menu, WebContentsView, session, shell } from "electron";
import type { ShellEvent } from "../shared/types";
import { appIconPath } from "./app-icon";
import { autoConfirmBluetoothPairing, wireBluetoothChooser } from "./bluetooth";
import { isShellCookieWrite } from "./session-cookies";

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
  const ses = session.fromPartition(partition);
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowed.has(permission) && details.requestingUrl.startsWith(origin));
  });
  // Web Bluetooth (Pixels dice) skips the permission handler; its chooser
  // and pairing prompts are wired per view in attachView.
  autoConfirmBluetoothPairing(ses);
}

export class ShellWindow {
  private win: BrowserWindow | null = null;
  private view: WebContentsView | null = null;
  private currentOrigin = "";
  private unwatchCookies: (() => void) | null = null;
  private onRevoked: ((origin: string) => void) | null = null;
  // Set while a browser-based sign-in (Discord OAuth) occupies the view.
  private loginCancel: ((reason: Error) => void) | null = null;

  // Fired when the server's own web UI logs the user out while its view is
  // attached. The window cannot forget the stored token itself (no store
  // access here); index.ts wires the handler where both pieces exist.
  onSessionRevoked(handler: (origin: string) => void): void {
    this.onRevoked = handler;
  }

  create(): void {
    this.win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      backgroundColor: "#0a0817",
      icon: appIconPath(),
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
    // The game preload exposes one thing, window.odmShell.showServers, so
    // the server's own account menu can offer the way back here.
    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "../preload/game.js"),
      },
    });
    this.view = view;
    this.currentOrigin = origin;
    this.watchForLogout(partition, origin);
    // The game UI pairs Pixels dice over Web Bluetooth; the shell provides
    // the device chooser Electron does not ship.
    wireBluetoothChooser(view.webContents, () => this.win);
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

  // Runs a server's own browser sign-in (Discord OAuth) in a throwaway
  // partition and resolves with the session the callback plants as the
  // odm_session cookie. The consent page lives on discord.com, so unlike a
  // game view this one may navigate anywhere over http(s); popups still go
  // to the system browser. Ctrl+M cancels. The view is torn down either
  // way; the caller re-attaches a proper game view with the session.
  browserLogin(
    origin: string,
    partition: string,
    startPath: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const win = this.win;
    if (!win) return Promise.reject(new Error("The window is gone."));
    this.cancelLogin(new Error("Sign-in was interrupted."));
    this.detachView();
    hardenPartition(partition, origin);
    const ses = session.fromPartition(partition);
    const view = new WebContentsView({
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.view = view;
    this.currentOrigin = origin;
    const host = new URL(origin).hostname;
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        ses.cookies.off("changed", onCookie);
        view.webContents.off("did-navigate", onNavigate);
        this.loginCancel = null;
        if (this.view === view) this.detachView();
      };
      const onCookie = (
        _event: Electron.Event,
        cookie: Electron.Cookie,
        _cause: string,
        removed: boolean,
      ): void => {
        if (removed || cookie.name !== "odm_session") return;
        if (cookie.domain && cookie.domain.replace(/^\./, "") !== host) return;
        const expiresAt = cookie.expirationDate
          ? new Date(cookie.expirationDate * 1000).toISOString()
          : "";
        cleanup();
        resolve({ token: cookie.value, expiresAt });
      };
      // A failed round trip lands back on the server as /?error=discord; a
      // server without Discord configured answers the start URL itself
      // with an error status instead of redirecting to the consent page.
      const onNavigate = (_event: Electron.Event, url: string, status: number): void => {
        if (!sameOrigin(url, origin)) return;
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return;
        }
        if (parsed.pathname === new URL(`${origin}${startPath}`).pathname && status >= 400) {
          cleanup();
          reject(new Error("This server has not set up Discord sign-in."));
          return;
        }
        if (!parsed.searchParams.get("error")) return;
        cleanup();
        reject(new Error("Discord sign-in failed. Try again."));
      };
      this.loginCancel = (reason) => {
        cleanup();
        reject(reason);
      };
      ses.cookies.on("changed", onCookie);
      view.webContents.on("did-navigate", onNavigate);
      view.webContents.setWindowOpenHandler(({ url }) => {
        openExternally(url);
        return { action: "deny" };
      });
      view.webContents.on("will-navigate", (event, url) => {
        if (!/^https?:/.test(url)) event.preventDefault();
      });
      win.contentView.addChildView(view);
      this.layout();
      void view.webContents.loadURL(`${origin}${startPath}`);
    });
  }

  private cancelLogin(reason: Error): void {
    const cancel = this.loginCancel;
    this.loginCancel = null;
    cancel?.(reason);
  }

  // Logging out inside the server's web UI revokes the session server-side;
  // left alone, the shell would keep a dead token and the user would be
  // stranded on the server's embedded login page. A real logout removes
  // odm_session explicitly (or overwrites it expired); the shell's own
  // applySessionCookie writes are flagged and skipped, and natural expiry
  // ("expired") is already covered by the stored token's expiry check.
  private watchForLogout(partition: string, origin: string): void {
    const cookies = session.fromPartition(partition).cookies;
    const host = new URL(origin).hostname;
    const listener = (
      _event: Electron.Event,
      cookie: Electron.Cookie,
      cause: string,
      removed: boolean,
    ): void => {
      if (!removed || cookie.name !== "odm_session") return;
      if (cause !== "explicit" && cause !== "expired-overwrite") return;
      if (isShellCookieWrite()) return;
      if (cookie.domain && cookie.domain.replace(/^\./, "") !== host) return;
      if (this.currentOrigin !== origin) return;
      this.onRevoked?.(origin);
      this.showManager();
    };
    cookies.on("changed", listener);
    this.unwatchCookies = () => cookies.off("changed", listener);
  }

  private detachView(): void {
    this.unwatchCookies?.();
    this.unwatchCookies = null;
    if (!this.win || !this.view) return;
    this.win.contentView.removeChildView(this.view);
    this.view.webContents.close();
    this.view = null;
    this.currentOrigin = "";
  }

  showManager(): void {
    if (this.loginCancel) {
      this.cancelLogin(new Error("Sign-in cancelled."));
      this.sendEvent({ kind: "show-manager" });
      return;
    }
    if (!this.view) return;
    this.detachView();
    this.sendEvent({ kind: "show-manager" });
  }
}
