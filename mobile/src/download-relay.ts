import { MAX_DOWNLOAD_BYTES, filenameFromUrl } from "./download-shim-core";

// Native side of the download bridge for the game webview. The injected shim
// (download-shim.ts) takes over an <a download> click inside the page and
// posts it here over the InAppBrowser message channel: a blob: link as its
// bytes in base64 (only the page can read those), an http(s) link as an
// address, which this relay streams natively into the app cache with the
// WebView's own cookies. Either way the file is parked in the cache and the
// system share sheet opens, where the player saves to Files or Drive or
// sends the file on. Dependencies are injected so tests drive the protocol
// against fakes; bridge.ts wires the real plugins in.

export interface NativeFetchResult {
  size: number;
  mime: string;
  // What the server called the file (Content-Disposition), "" without one.
  suggestedName: string;
}

export interface DownloadRelayDeps {
  // Writes base64 bytes at a path under the app cache directory, creating
  // parent folders, and returns the resulting file:// uri.
  writeCache(path: string, base64: string): Promise<string>;
  // Removes a cache folder and its contents; a missing folder is fine.
  clearCache(path: string): Promise<void>;
  // Streams an http(s) address into DOWNLOAD_FOLDER/INCOMING_NAME with the
  // cookies for it plus these headers, within the size cap. Rejects when
  // the server refuses, the file is too big or the network fails.
  fetchToCache(url: string, headers: Record<string, string>): Promise<NativeFetchResult>;
  // Renames a cache file and returns its file:// uri.
  renameCache(from: string, to: string): Promise<string>;
  // Opens the system share sheet for one file. Rejects with a message
  // containing "cancel" when the player backs out.
  share(title: string, uri: string): Promise<void>;
  // Shows the player a short message.
  notify(message: string): void;
}

export const DOWNLOAD_FOLDER = "odm-downloads";
// Where a streamed file lands before it has a name.
export const INCOMING_NAME = "incoming.part";
// 40 MB of bytes is about 53.4 MB of base64; a little headroom on top.
export const MAX_DOWNLOAD_B64_CHARS = 56 * 1024 * 1024;
const MAX_NAME_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 200;
const MAX_URL_LENGTH = 4096;

// The share sheet derives the MIME type from the extension, so a nameless
// export still needs one for the receiving app to open it.
const EXTENSION_BY_MIME: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/json": ".json",
  "text/html": ".html",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/zip": ".zip",
  "application/vnd.oasis.opendocument.text": ".odt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
};

export function extensionFor(mime: unknown): string {
  const type = typeof mime === "string" ? (mime.split(";")[0] ?? "").trim().toLowerCase() : "";
  return EXTENSION_BY_MIME[type] ?? "";
}

// Everything arriving from the webview is untrusted page input. The name
// becomes a single path segment under the cache folder: no separators, no
// traversal, no control characters, and a bounded length that keeps the
// extension intact.
export function sanitizeFilename(name: unknown, mime: unknown): string {
  const cleaned = Array.from(typeof name === "string" ? name : "")
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch !== "\u007f")
    .join("")
    .replace(/[\\/]+/g, "-")
    .replace(/[<>:"|?*]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.-]+/, "")
    .replace(/[. ]+$/, "");
  const dot = cleaned.lastIndexOf(".");
  const hasExtension = dot > 0 && /^\.[A-Za-z0-9]{1,15}$/.test(cleaned.slice(dot));
  let stem = hasExtension ? cleaned.slice(0, dot) : cleaned;
  const extension = hasExtension ? cleaned.slice(dot) : extensionFor(mime);
  stem = stem.slice(0, MAX_NAME_LENGTH - extension.length).replace(/[. ]+$/, "") || "download";
  return stem + extension;
}

// btoa never emits whitespace, so anything outside the alphabet is a
// corrupt or hostile payload rather than a formatting quirk.
const BASE64_SHAPE = /^[A-Za-z0-9+/]*={0,2}$/;

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

// A web address the relay may stream, or "" for anything else (a page
// could post any string here). With an origin given, only that origin's
// files are fetched: the page's own cookies go with the request, and no
// page gets to spend another host's session.
export function fetchableUrl(raw: unknown, origin?: string): string {
  if (typeof raw !== "string" || raw.length > MAX_URL_LENGTH) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (origin && url.origin !== origin) return "";
    return url.href;
  } catch {
    return "";
  }
}

export function createDownloadRelay(deps: DownloadRelayDeps): {
  // Returns false for messages that are not download traffic, so the
  // caller can route other webview messages elsewhere. origin, when given,
  // is the only host an address message may point at.
  handleMessage(detail: unknown, options?: { origin?: string }): Promise<boolean>;
  // Streams a host file with these headers and hands it to the share
  // sheet. True when the file arrived (whatever the player did with the
  // sheet); false after a failure, which the player has been told about.
  download(url: string, name: string, headers: Record<string, string>): Promise<boolean>;
} {
  // Downloads run one at a time: each clears the cache folder before
  // writing, and a file mid-share must not be swept away by the next one.
  let queue: Promise<void> = Promise.resolve();

  function report(name: string, err: unknown): void {
    const message = err instanceof Error ? err.message : "";
    // Backing out of the share sheet is a choice, not a failure.
    if (/cancel/i.test(message)) return;
    deps.notify(`Could not save ${name}. ${message || "Something went wrong."}`.trim());
  }

  async function save(name: string, data: string): Promise<void> {
    try {
      await deps.clearCache(DOWNLOAD_FOLDER).catch(() => undefined);
      const uri = await deps.writeCache(`${DOWNLOAD_FOLDER}/${name}`, data);
      await deps.share(name, uri);
    } catch (err) {
      report(name, err);
    }
  }

  async function stream(url: string, wanted: string, headers: Record<string, string>): Promise<boolean> {
    // The name the notice uses if the fetch never says what the file is.
    let name = sanitizeFilename(wanted || filenameFromUrl(url), "");
    try {
      await deps.clearCache(DOWNLOAD_FOLDER).catch(() => undefined);
      const fetched = await deps.fetchToCache(url, headers);
      if (fetched.size > MAX_DOWNLOAD_BYTES) {
        deps.notify(`${name} is larger than the 40 MB the app can hand off.`);
        return false;
      }
      name = sanitizeFilename(wanted || fetched.suggestedName || filenameFromUrl(url), fetched.mime);
      const uri = await deps.renameCache(`${DOWNLOAD_FOLDER}/${INCOMING_NAME}`, `${DOWNLOAD_FOLDER}/${name}`);
      try {
        await deps.share(name, uri);
      } catch (err) {
        report(name, err);
      }
      return true;
    } catch (err) {
      report(name, err);
      return false;
    }
  }

  function download(url: string, name: string, headers: Record<string, string>): Promise<boolean> {
    const run = queue.then(() => stream(url, name, headers));
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    download,
    async handleMessage(detail: unknown, options = {}): Promise<boolean> {
      const msg = detail as { type?: unknown; name?: unknown; mime?: unknown; data?: unknown; message?: unknown; url?: unknown } | null;
      if (!msg || typeof msg !== "object") return false;
      if (msg.type === "odm-download-error") {
        deps.notify(str(msg.message, MAX_MESSAGE_LENGTH) || "The download failed.");
        return true;
      }
      if (msg.type === "odm-download-url") {
        const url = fetchableUrl(msg.url, options.origin);
        if (!url) {
          deps.notify("That download is not from this server.");
          return true;
        }
        await download(url, str(msg.name, MAX_NAME_LENGTH), {});
        return true;
      }
      if (msg.type !== "odm-download") return false;
      const name = sanitizeFilename(msg.name, msg.mime);
      const data = typeof msg.data === "string" ? msg.data : "";
      if (!data) {
        deps.notify(`${name} came through empty.`);
        return true;
      }
      if (data.length > MAX_DOWNLOAD_B64_CHARS) {
        deps.notify(`${name} is larger than the 40 MB the app can hand off.`);
        return true;
      }
      if (!BASE64_SHAPE.test(data)) {
        deps.notify(`${name} arrived corrupted.`);
        return true;
      }
      queue = queue.then(() => save(name, data));
      await queue;
      return true;
    },
  };
}
