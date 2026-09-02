import { createDownloadShim, noticeText, type AnchorLike } from "./download-shim-core";

// Injection entry for the game webview, delivered alongside the Web
// Bluetooth polyfill through the InAppBrowser preShowScript. Two hooks feed
// the same core: a capture-phase click listener on document for real taps
// and anchors that were appended before being clicked, and a wrap of the
// anchor's programmatic click() for anchors that are created, clicked and
// dropped without ever joining the document (Chromium still downloads those,
// but their click event never reaches document). Messages ride the plugin's
// window.mobileApp channel; the "messageFromNative" event carries short
// notices back down, rendered here as a toast because the manager UI sits
// hidden under the game webview.

(() => {
  type MobileApp = { postMessage(message: Record<string, unknown>): void };
  const win = window as Window & { mobileApp?: MobileApp; odmDownloadShim?: boolean };
  if (win.odmDownloadShim) return;
  win.odmDownloadShim = true;

  const shim = createDownloadShim({
    origin: window.location.origin,
    fetch: (url) => fetch(url, { credentials: "include" }),
    channel() {
      const app = win.mobileApp;
      return app && typeof app.postMessage === "function" ? app : null;
    },
  });

  document.addEventListener("click", (event) => shim.onClick(event), true);

  const proto = HTMLAnchorElement.prototype as HTMLAnchorElement & { click(): void };
  const nativeClick = proto.click;
  proto.click = function click(this: HTMLAnchorElement): void {
    if (!shim.handleAnchor(this as AnchorLike)) nativeClick.call(this);
  };

  const TOAST_MS = 4000;
  let toast: HTMLDivElement | null = null;
  let hide: ReturnType<typeof setTimeout> | null = null;
  const showToast = (text: string): void => {
    const host = document.body ?? document.documentElement;
    if (!host) return;
    if (!toast) {
      toast = document.createElement("div");
      toast.setAttribute("role", "status");
      toast.style.cssText = [
        "position:fixed",
        "left:50%",
        "bottom:24px",
        "transform:translateX(-50%)",
        "max-width:90vw",
        "padding:10px 14px",
        "border-radius:8px",
        "background:rgba(20,20,20,0.92)",
        "color:#fff",
        "font:14px system-ui,sans-serif",
        "z-index:2147483647",
        "pointer-events:none",
      ].join(";");
    }
    toast.textContent = text;
    if (!toast.isConnected) host.appendChild(toast);
    if (hide) clearTimeout(hide);
    hide = setTimeout(() => {
      toast?.remove();
      hide = null;
    }, TOAST_MS);
  };

  window.addEventListener("messageFromNative", (event) => {
    const text = noticeText((event as CustomEvent<unknown>).detail);
    if (text) showToast(text);
  });
})();
