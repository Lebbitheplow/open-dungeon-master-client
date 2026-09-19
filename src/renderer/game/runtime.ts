// What the host's pages assume about their world, supplied by the shell:
// a same-origin API (fetch of root-relative paths goes to the host with
// the bearer token), an event stream (EventSource cannot carry a header,
// so it is a fetch-backed stand-in), pictures and audio behind the login
// (root-relative sources become object URLs fetched with the token), and
// the window.odmShell contract the pages already use inside the apps.
import type { HostClient } from "../api/host.js";
import type { SseEvent } from "../../shared/sse.js";
import { createObjectUrlCache } from "../../shared/object-url-cache.js";

// Public static files of the host: no session needed, so the address is
// rewritten in place and the browser loads them itself.
const PUBLIC_PREFIXES = ["/assets/", "/fx/", "/sidebar-icons/", "/dice-box/", "/icon", "/apple-icon"];
// Everything else root-relative that a media element asks for is behind
// the host's login and is fetched with the token.
const MEDIA_ATTRS = ["src", "poster"];
// The battle map is an SVG, and what it shows under and on the grid (a
// backdrop, the DM's overlay, a token's portrait or plate, an effect sheet)
// is an SVG <image>, whose address is its href. Left alone it would load from
// the app's own origin and draw nothing.
const SVG_IMAGE_ATTRS = ["href"];
const MEDIA_SELECTOR = "img, audio, video, source, image";

let active: HostClient | null = null;
let nativeFetch: typeof fetch | null = null;
let nativeEventSource: typeof EventSource | null = null;
let observer: MutationObserver | null = null;
let mediaPatched = false;
// Sixty-four protected paths at a time, the oldest revoked as newer ones
// arrive (docs/vtt-parity-implementation-plan.md 18.3).
// Pictures fetched with the player's token (portraits, uploads, generated
// art) live as object URLs. The cache drops the oldest past its cap, and a
// dropped URL is revoked only when nothing on the page still shows it: the
// table alone asks for more than a hundred pictures, and revoking one that an
// element was showing, or was about to be handed, left a broken portrait.
function revokeIfUnused(url: string): void {
  const inUse = document.querySelector(`[src="${url}"], [href="${url}"]`);
  if (!inUse) URL.revokeObjectURL(url);
}
const objectUrls = createObjectUrlCache(256, revokeIfUnused);

function isRootRelative(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const client = active;
  const base = nativeFetch ?? fetch;
  if (!client) return base(input, init);
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!isRootRelative(url)) return base(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("authorization", `Bearer ${client.session.token}`);
  headers.set("x-odm-client", "shell");
  return base(`${client.origin}${url}`, { ...init, headers, credentials: "omit" });
}

// EventSource with a bearer header, on the HostClient's stream.
class HostEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly url: string;
  readonly withCredentials = false;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private handle: { close(): void } | null = null;

  constructor(url: string | URL) {
    super();
    this.url = typeof url === "string" ? url : url.href;
    const client = active;
    if (!client || !isRootRelative(this.url)) {
      const real = nativeEventSource;
      if (!real) throw new Error("EventSource unavailable.");
      // Not a host stream: hand the real thing back to the caller.
      return new real(this.url) as unknown as HostEventSource;
    }
    this.handle = client.stream(
      this.url,
      (event: SseEvent) => {
        const message = new MessageEvent(event.event, { data: event.data, lastEventId: event.id });
        this.dispatchEvent(message);
        if (event.event === "message") this.onmessage?.(message);
      },
      (open) => {
        this.readyState = open ? 1 : 0;
        const event = new Event(open ? "open" : "error");
        this.dispatchEvent(event);
        if (open) this.onopen?.(event);
        else this.onerror?.(event);
      },
    );
  }

  close(): void {
    this.readyState = 2;
    this.handle?.close();
    this.handle = null;
  }
}

function objectUrlFor(client: HostClient, path: string): Promise<string> {
  return objectUrls.get(`${client.origin}${path}`, () => client.objectUrl(path));
}

// The painted icons ship inside the app (scripts/build-renderer.mjs copies the
// server's public/assets/icons beside the game bundle), so their addresses
// resolve to the app's own files whether or not a host is connected. The
// shell's Settings screen draws the audio and dice panel with no host at all,
// and before this its icons pointed at files the app did not have.
const LOCAL_ICONS = "/assets/icons/";

function localAsset(value: string): string | null {
  if (!value.startsWith(LOCAL_ICONS)) return null;
  return new URL(`game/icons/${value.slice(LOCAL_ICONS.length)}`, document.baseURI).href;
}

// Media elements: a public path is pointed at the host directly; a
// protected one is loaded through the token and swapped for a blob.
function fixMedia(element: Element): void {
  const client = active;
  for (const attr of element.localName === "image" ? SVG_IMAGE_ATTRS : MEDIA_ATTRS) {
    const value = element.getAttribute(attr);
    if (!value || !isRootRelative(value)) continue;
    if (element.getAttribute(`data-odm-${attr}`) === value) continue;
    const local = localAsset(value);
    if (local) {
      element.setAttribute(`data-odm-${attr}`, value);
      element.setAttribute(attr, local);
      continue;
    }
    if (!client) continue;
    element.setAttribute(`data-odm-${attr}`, value);
    if (PUBLIC_PREFIXES.some((prefix) => value.startsWith(prefix))) {
      element.setAttribute(attr, `${client.origin}${value}`);
      continue;
    }
    void objectUrlFor(client, value).then((url) => {
      if (url && element.getAttribute(`data-odm-${attr}`) === value) element.setAttribute(attr, url);
    });
  }
}

// The address a media element should really load: the host for a public
// path, an object URL (fetched with the token) for a protected one. The
// second case is asynchronous, so the caller gets the object URL later.
function resolveMedia(client: HostClient, value: string, apply: (url: string) => void): string | null {
  if (!isRootRelative(value)) return null;
  if (PUBLIC_PREFIXES.some((prefix) => value.startsWith(prefix))) return `${client.origin}${value}`;
  void objectUrlFor(client, value).then((url) => {
    if (url) apply(url);
  });
  return null;
}

// new Audio(url), new Image() and element.src = "/..." never touch an
// attribute the observer would see before the load starts, so the src
// setters are wrapped: a public path is redirected at once, a protected
// one is fetched first and then assigned.
function patchMediaSetters(): void {
  if (mediaPatched) return;
  mediaPatched = true;
  for (const proto of [HTMLMediaElement.prototype, HTMLImageElement.prototype, HTMLSourceElement.prototype]) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, "src");
    if (!descriptor?.set || !descriptor.get) continue;
    const nativeSet = descriptor.set;
    Object.defineProperty(proto, "src", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(this: HTMLElement, value: string) {
        const client = active;
        const raw = String(value);
        const local = isRootRelative(raw) ? localAsset(raw) : null;
        if (local) {
          this.setAttribute("data-odm-src", raw);
          nativeSet.call(this, local);
          return;
        }
        if (!client || !isRootRelative(raw)) {
          nativeSet.call(this, value);
          return;
        }
        this.setAttribute("data-odm-src", raw);
        const direct = resolveMedia(client, raw, (url) => {
          if (this.getAttribute("data-odm-src") === raw) nativeSet.call(this, url);
        });
        if (direct) nativeSet.call(this, direct);
      },
    });
  }
  const NativeAudio = window.Audio;
  const PatchedAudio = function Audio(this: HTMLAudioElement, src?: string): HTMLAudioElement {
    const element = new NativeAudio();
    if (src !== undefined) element.src = src;
    return element;
  } as unknown as typeof HTMLAudioElement;
  PatchedAudio.prototype = NativeAudio.prototype;
  window.Audio = PatchedAudio;
}

function scan(root: Node): void {
  if (root instanceof Element) {
    if (root.matches(MEDIA_SELECTOR)) fixMedia(root);
    for (const node of root.querySelectorAll(MEDIA_SELECTOR)) fixMedia(node);
  }
}

// A file name from Content-Disposition, or the last path piece.
function downloadName(response: Response, path: string, preferred: string): string {
  if (preferred) return preferred;
  const disposition = response.headers.get("content-disposition") ?? "";
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  if (plain?.[1]) return plain[1].trim();
  const last = path.split("?")[0]?.split("/").filter(Boolean).pop() ?? "";
  return last || "download";
}

// <a download href="/api/..."> in the app's own page would look for the
// file on disk; the bytes are fetched with the session instead and handed
// to the download manager as a blob. On Android the shell's download
// bridge (mobile/src/bridge.ts) takes the click first and this never runs.
function onDownloadClick(event: MouseEvent): void {
  const client = active;
  if (!client || event.defaultPrevented) return;
  const anchor = (event.target as Element | null)?.closest("a[href][download]");
  if (!(anchor instanceof HTMLAnchorElement)) return;
  const href = anchor.getAttribute("href") ?? "";
  if (!isRootRelative(href)) return;
  event.preventDefault();
  const preferred = anchor.getAttribute("download") ?? "";
  void patchedFetch(href)
    .then(async (response) => {
      if (!response.ok) throw new Error(`Download failed (${response.status}).`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = downloadName(response, href, preferred);
      link.style.display = "none";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    })
    .catch((error: unknown) => console.error("download failed", error));
}

// A host picture is first asked for at the app's OWN address: the page sets
// src="/uploads/x.png", which from file:// or capacitor:// is a file that does
// not exist, and only then does the observer point it at the host. That first
// request fails at once, and a component with an error fallback (the faces on
// the board's turn rail, the painted icons) hears the failure and gives the
// picture up before the real copy has been asked for. The failure of the app's
// own bogus request is not news to anyone: it stops here, in the capture
// phase, and the element is fixed straight away.
const HOST_PATHS = ["/uploads/", "/generated/", "/generated-audio/", "/ambience/", "/assets/", "/fx/", "/sidebar-icons/", "/dice-box/", "/api/"];
let errorsGuarded = false;

function guardBogusErrors(): void {
  if (errorsGuarded) return;
  errorsGuarded = true;
  document.addEventListener(
    "error",
    (event) => {
      const element = event.target;
      if (!(element instanceof Element) || !active) return;
      const failed = (element as HTMLImageElement).currentSrc || element.getAttribute("src") || element.getAttribute("href") || "";
      let path = "";
      try {
        const url = new URL(failed, document.baseURI);
        // Only the app's own origin: a picture the HOST refused is real news.
        if (url.origin !== new URL(document.baseURI).origin && url.protocol !== "file:") return;
        path = url.pathname;
      } catch {
        return;
      }
      if (!HOST_PATHS.some((prefix) => path.startsWith(prefix))) return;
      event.stopImmediatePropagation();
      // The observer may not have reached it yet; the address is still the
      // root-relative one, so clear the marker and fix it now.
      for (const attr of ["src", "href", "xlink:href"]) {
        if (element.getAttribute(`data-odm-${attr}`) === element.getAttribute(attr)) element.removeAttribute(`data-odm-${attr}`);
      }
      fixMedia(element);
    },
    true,
  );
}

// For the app's own screens that draw a game panel with no host connected
// (Settings): only the picture setters, which send the painted icons to the
// app's own copy. Nothing else of the runtime needs a host-less page.
export function installLocalAssets(): void {
  patchMediaSetters();
}

export function installRuntime(client: HostClient): void {
  active = client;
  guardBogusErrors();
  document.removeEventListener("click", onDownloadClick);
  document.addEventListener("click", onDownloadClick);
  if (!nativeFetch) {
    nativeFetch = window.fetch.bind(window);
    window.fetch = patchedFetch;
  }
  if (!nativeEventSource) {
    nativeEventSource = window.EventSource;
    window.EventSource = HostEventSource as unknown as typeof EventSource;
  }
  patchMediaSetters();
  if (!observer) {
    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && record.target instanceof Element && record.target.matches(MEDIA_SELECTOR)) {
          fixMedia(record.target);
        }
        for (const node of record.addedNodes) scan(node);
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [...MEDIA_ATTRS, ...SVG_IMAGE_ATTRS],
    });
  }
  scan(document.body);
}

export function activeHost(): HostClient | null {
  return active;
}

export function uninstallRuntime(): void {
  active = null;
  document.removeEventListener("click", onDownloadClick);
  objectUrls.clear();
}
