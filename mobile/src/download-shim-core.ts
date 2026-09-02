// Browser side of the download bridge for the game webview. The Android
// WebView the game runs in has no download handler, so an <a download> click
// (character-sheet PDF, workshop bundle, story export) would silently do
// nothing. This core decides which clicks to take over, fetches the file in
// the page where the session cookie and blob: URLs are valid, and posts the
// bytes to the shell as base64; download-relay.ts saves and shares them
// natively. DOM and transport are injected so the logic runs under Node.

export const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;
export const DOWNLOAD_MESSAGE = "odm-download";
export const DOWNLOAD_ERROR_MESSAGE = "odm-download-error";
export const DOWNLOAD_NOTICE_MESSAGE = "odm-download-notice";

// The slice of an Element the shim reads while walking up from a click
// target. Real nodes satisfy it; tests hand in plain objects.
export interface AnchorLike {
  tagName?: string;
  href?: string;
  hasAttribute?(name: string): boolean;
  getAttribute?(name: string): string | null;
  parentElement?: AnchorLike | null;
  parentNode?: AnchorLike | null;
}

export interface ClickLike {
  target: unknown;
  defaultPrevented: boolean;
  button?: number;
  preventDefault(): void;
}

export interface ResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface DownloadChannel {
  postMessage(message: Record<string, unknown>): void;
}

export interface DownloadShimDeps {
  // The page origin; only blob: and same-origin http(s) links are bridged.
  origin: string;
  fetch(url: string): Promise<ResponseLike>;
  // The plugin's window.mobileApp, or null while it is absent. Without a
  // channel the click is left alone entirely.
  channel(): DownloadChannel | null;
}

function isDownloadAnchor(node: AnchorLike): boolean {
  return (
    String(node.tagName ?? "").toUpperCase() === "A" &&
    typeof node.hasAttribute === "function" &&
    node.hasAttribute("download")
  );
}

// Clicks land on the icon or text inside the anchor as often as on the
// anchor itself, so walk up; the depth cap only guards against cyclic fakes.
export function findDownloadAnchor(target: unknown): AnchorLike | null {
  let node = (target ?? null) as AnchorLike | null;
  for (let depth = 0; node && depth < 64; depth += 1) {
    if (isDownloadAnchor(node)) return node;
    node = node.parentElement ?? node.parentNode ?? null;
  }
  return null;
}

// Resolves the href and returns it when the shim may fetch it, else "".
// Cross-origin links stay with the browser: the fetch would be blocked by
// CORS anyway and the page should not read foreign bytes through the shell.
export function bridgeableHref(href: unknown, origin: string): string {
  const raw = typeof href === "string" ? href.trim() : "";
  if (!raw) return "";
  if (raw.startsWith("blob:")) return raw;
  try {
    const url = new URL(raw, origin);
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin === origin) {
      return url.href;
    }
  } catch {
    // Unparseable hrefs are not ours to handle.
  }
  return "";
}

// Content-Disposition carries the name for server-side exports. The RFC
// 5987 form (filename*=UTF-8''...) wins over the plain one when both exist.
export function filenameFromDisposition(header: string | null | undefined): string {
  const value = header ?? "";
  const extended = /filename\*\s*=\s*[\w-]+'[^']*'([^;]+)/i.exec(value);
  if (extended) {
    try {
      const decoded = decodeURIComponent((extended[1] ?? "").trim()).trim();
      if (decoded) return decoded;
    } catch {
      // Fall through to the plain parameter.
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(value);
  if (quoted) return (quoted[1] ?? "").replace(/\\(.)/g, "$1").trim();
  const bare = /filename\s*=\s*([^;]+)/i.exec(value);
  return bare ? (bare[1] ?? "").trim() : "";
}

export function filenameFromUrl(href: string): string {
  try {
    const last = new URL(href).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(last);
  } catch {
    return "";
  }
}

// blob: URLs end in a UUID, which is no name at all, so they skip the path
// fallback. The native side sanitizes whatever comes out of here.
export function deriveFilename(
  download: string,
  disposition: string | null | undefined,
  href: string,
): string {
  return (
    download.trim() ||
    filenameFromDisposition(disposition) ||
    (href.startsWith("blob:") ? "" : filenameFromUrl(href)) ||
    "download"
  );
}

export function mimeFromContentType(header: string | null | undefined): string {
  const type = ((header ?? "").split(";")[0] ?? "").trim().toLowerCase();
  return type || "application/octet-stream";
}

// Chunk size is a multiple of 3 so every chunk encodes without padding and
// the pieces concatenate into one valid base64 string. Encoding chunk by
// chunk keeps the intermediate binary string small for multi-megabyte PDFs.
const B64_CHUNK = 0x6000;

export function bytesToB64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    out += btoa(String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK)));
  }
  return out;
}

// The text the shell asks the page to show, or "" for unrelated messages.
export function noticeText(detail: unknown): string {
  const msg = detail as { type?: unknown; message?: unknown } | null;
  if (!msg || typeof msg !== "object" || msg.type !== DOWNLOAD_NOTICE_MESSAGE) return "";
  return typeof msg.message === "string" ? msg.message.slice(0, 200) : "";
}

export function createDownloadShim(deps: DownloadShimDeps): {
  // Takes over the anchor when it is bridgeable; false means leave it to
  // the browser. Used for programmatic clicks on detached anchors.
  handleAnchor(anchor: AnchorLike): boolean;
  onClick(event: ClickLike): void;
} {
  async function capture(
    channel: DownloadChannel,
    href: string,
    download: string,
  ): Promise<void> {
    const name = deriveFilename(download, null, href);
    const fail = (message: string): void => {
      channel.postMessage({ detail: { type: DOWNLOAD_ERROR_MESSAGE, name, message } });
    };
    try {
      const response = await deps.fetch(href);
      if (!response.ok) {
        fail(`The server answered ${response.status}.`);
        return;
      }
      const tooBig = `${name} is larger than the 40 MB the app can hand off.`;
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > MAX_DOWNLOAD_BYTES) {
        fail(tooBig);
        return;
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
        fail(tooBig);
        return;
      }
      channel.postMessage({
        detail: {
          type: DOWNLOAD_MESSAGE,
          name: deriveFilename(download, response.headers.get("content-disposition"), href),
          mime: mimeFromContentType(response.headers.get("content-type")),
          data: bytesToB64(new Uint8Array(buffer)),
        },
      });
    } catch (err) {
      fail(err instanceof Error && err.message ? err.message : "Could not read the file.");
    }
  }

  function handleAnchor(anchor: AnchorLike): boolean {
    const rawHref =
      typeof anchor.href === "string" && anchor.href
        ? anchor.href
        : (anchor.getAttribute?.("href") ?? "");
    const href = bridgeableHref(rawHref, deps.origin);
    if (!href) return false;
    const channel = deps.channel();
    if (!channel) return false;
    void capture(channel, href, anchor.getAttribute?.("download") ?? "");
    return true;
  }

  return {
    handleAnchor,
    onClick(event) {
      // Someone upstream already claimed the click, or it is not a primary
      // button press; neither would start a download in the browser either.
      if (event.defaultPrevented || (event.button ?? 0) !== 0) return;
      const anchor = findDownloadAnchor(event.target);
      if (!anchor || !isDownloadAnchor(anchor)) return;
      if (handleAnchor(anchor)) event.preventDefault();
    },
  };
}
