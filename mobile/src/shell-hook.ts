// Injected into every server page (documentStart, next to the BLE polyfill
// and download shim) so the game knows it is running inside the app. The
// server's account menu shows a "Switch server" entry when window.odmShell
// exists; choosing it posts back here and the bridge closes the game
// webview, landing on the server list. Same contract as the desktop
// preload (src/preload/game.ts), so one server-side check covers both.
(() => {
  interface ShellHost {
    platform: "android";
    showServers(): void;
  }
  interface HookWindow {
    odmShell?: ShellHost;
    mobileApp?: { postMessage(message: unknown): void };
    AndroidInterface?: { postMessage(message: string): void };
  }
  const host = window as unknown as HookWindow;
  if (host.odmShell) return;
  const message = { odmShell: "servers" };
  host.odmShell = {
    platform: "android",
    showServers() {
      // mobileApp is the plugin's own bridge object, injected after load;
      // AndroidInterface is the raw JavascriptInterface it wraps.
      if (host.mobileApp && typeof host.mobileApp.postMessage === "function") {
        host.mobileApp.postMessage(message);
      } else if (host.AndroidInterface) {
        host.AndroidInterface.postMessage(JSON.stringify(message));
      }
    },
  };
})();
