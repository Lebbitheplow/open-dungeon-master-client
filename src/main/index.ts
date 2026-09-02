import path from "node:path";
import { app, safeStorage } from "electron";
import { joinLinkFromArgv, parseJoinLink, type JoinLink } from "../shared/deep-link";
import { LocalAiManager } from "./local-ai/manager";
import { LocalServer } from "./local-server";
import { registerIpc, type ShellIpc } from "./ipc";
import { LOCAL_SERVER_ID, ServerStore, type TokenCrypt } from "./servers";
import { QuickTunnel } from "./tunnel";
import { detectInstallKind, Updater } from "./updater";
import { ShellWindow } from "./window";

// Session tokens go through the OS keychain when one is available. The
// "plain:" fallback (headless Linux without a keyring) is marked so tokens
// encrypted one way are never misread the other.
function makeCrypt(): TokenCrypt {
  return {
    encrypt(plain: string): string {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.encryptString(plain).toString("base64");
      }
      return `plain:${Buffer.from(plain, "utf8").toString("base64")}`;
    },
    decrypt(cipher: string): string | null {
      try {
        if (cipher.startsWith("plain:")) {
          return Buffer.from(cipher.slice(6), "base64").toString("utf8");
        }
        return safeStorage.decryptString(Buffer.from(cipher, "base64"));
      } catch {
        return null;
      }
    },
  };
}

function main(): void {
  // A stable directory name across dev and packaged runs, so accounts and
  // the offline world never depend on how the app was launched.
  app.setPath("userData", path.join(app.getPath("appData"), "open-dungeon-master-client"));

  let pendingJoin: JoinLink | null = joinLinkFromArgv(process.argv);
  let ipc: ShellIpc | null = null;
  let win: ShellWindow | null = null;

  const dispatch = (link: JoinLink): void => {
    if (ipc) {
      void ipc.handleJoinLink(link);
    } else {
      pendingJoin = link;
    }
  };

  // Register the odm:// handler. A dev run ("electron .") must tell the OS
  // how to relaunch us with the app path.
  if (process.defaultApp) {
    if (process.argv[1]) {
      app.setAsDefaultProtocolClient("odm", process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient("odm");
  }

  app.on("second-instance", (_event, argv) => {
    win?.focus();
    const link = joinLinkFromArgv(argv);
    if (link) dispatch(link);
  });

  // macOS delivers deep links here instead of argv.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    const link = parseJoinLink(url);
    if (link) dispatch(link);
  });

  void app.whenReady().then(async () => {
    const store = new ServerStore(path.join(app.getPath("userData"), "servers.json"), makeCrypt());
    const payloadDir = app.isPackaged
      ? path.join(process.resourcesPath, "server")
      : path.join(app.getAppPath(), "vendor", "server");
    const local = new LocalServer(payloadDir, app.getPath("userData"));
    const tunnel = new QuickTunnel(
      path.join(app.getPath("userData"), "bin"),
      path.join(app.getPath("userData"), "tunnel.log"),
    );
    const localAi = new LocalAiManager(path.join(app.getPath("userData"), "local-ai"));
    const updater = new Updater(
      detectInstallKind(process.env, process.execPath, process.platform, app.isPackaged),
      app.getVersion(),
    );

    win = new ShellWindow();
    win.create();
    // A logout inside the server's web UI already revoked the session
    // server-side; forget the matching stored token so the server list does
    // not offer a dead one. The local entry keeps its secretCipher, so the
    // next Play signs back in silently, which is the desired local behavior.
    win.onSessionRevoked((origin) => {
      const entry =
        origin === local.origin ? store.get(LOCAL_SERVER_ID) : store.findByOrigin(origin);
      if (entry) store.clearToken(entry.id);
    });
    ipc = registerIpc({ store, window: win, local, tunnel, localAi, updater });
    updater.checkOnStartup();

    app.on("before-quit", () => {
      void tunnel.stop();
      void localAi.stop();
      void local.stop();
    });
    app.on("window-all-closed", () => {
      void tunnel
        .stop()
        .then(() => localAi.stop())
        .then(() => local.stop())
        .finally(() => app.quit());
    });

    await win.whenPageReady();
    if (pendingJoin) {
      const link = pendingJoin;
      pendingJoin = null;
      void ipc.handleJoinLink(link);
    }
  });
}

if (app.requestSingleInstanceLock()) {
  main();
} else {
  app.quit();
}
