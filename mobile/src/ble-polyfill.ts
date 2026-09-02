import { createWebBluetooth, type BleBridgeTransport } from "./ble-polyfill-core";

// Injection entry for the game webview, delivered through the InAppBrowser
// preShowScript at documentStart so navigator.bluetooth exists before the
// game's feature detection runs. The transport rides the plugin's built-in
// channel: window.mobileApp.postMessage up to the shell, and the
// "messageFromNative" window event back down. mobileApp is injected by the
// plugin itself; sends queue briefly in case this script lands first.

(() => {
  const nav = navigator as Navigator & { bluetooth?: unknown };
  if (nav.bluetooth) return;

  type MobileApp = { postMessage(message: Record<string, unknown>): void };
  const queue: Record<string, unknown>[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    const app = (window as Window & { mobileApp?: MobileApp }).mobileApp;
    if (!app || typeof app.postMessage !== "function") {
      timer ??= setTimeout(() => {
        timer = null;
        flush();
      }, 250);
      return;
    }
    while (queue.length > 0) app.postMessage(queue.shift() as Record<string, unknown>);
  };

  const transport: BleBridgeTransport = {
    send(message) {
      queue.push(message);
      flush();
    },
    onMessage(listener) {
      window.addEventListener("messageFromNative", (event) => {
        const detail = (event as CustomEvent<Record<string, unknown>>).detail;
        if (detail && typeof detail === "object") listener(detail);
      });
    },
  };

  Object.defineProperty(nav, "bluetooth", {
    value: createWebBluetooth(transport),
    configurable: true,
  });
})();
