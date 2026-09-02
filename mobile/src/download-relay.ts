// Native side of the download bridge for the game webview. The injected shim
// (download-shim.ts) fetches an <a download> target inside the page and
// posts its bytes here as base64 over the InAppBrowser message channel; this
// relay parks them in the app cache and opens the system share sheet, where
// the player saves to Files or Drive or sends the file on. Dependencies are
// injected so tests drive the protocol against fakes; bridge.ts wires the
// real Filesystem, Share and InAppBrowser plugins in.

export interface DownloadRelayDeps {
  // Writes base64 bytes at a path under the app cache directory, creating
  // parent folders, and returns the resulting file:// uri.
  writeCache(path: string, base64: string): Promise<string>;
  // Removes a cache folder and its contents; a missing folder is fine.
  clearCache(path: string): Promise<void>;
  // Opens the system share sheet for one file. Rejects with a message
  // containing "cancel" when the player backs out.
  share(title: string, uri: string): Promise<void>;
  // Shows the player a short message.
  notify(message: string): void;
}

export const DOWNLOAD_FOLDER = "odm-downloads";
// 40 MB of bytes is about 53.4 MB of base64; a little headroom on top.
export const MAX_DOWNLOAD_B64_CHARS = 56 * 1024 * 1024;
const MAX_NAME_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 200;

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

function extensionFor(mime: unknown): string {
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

export function createDownloadRelay(deps: DownloadRelayDeps): {
  handleMessage(detail: unknown): Promise<boolean>;
} {
  // Downloads run one at a time: each clears the cache folder before
  // writing, and a file mid-share must not be swept away by the next one.
  let queue: Promise<void> = Promise.resolve();

  async function save(name: string, data: string): Promise<void> {
    try {
      await deps.clearCache(DOWNLOAD_FOLDER).catch(() => undefined);
      const uri = await deps.writeCache(`${DOWNLOAD_FOLDER}/${name}`, data);
      await deps.share(name, uri);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      // Backing out of the share sheet is a choice, not a failure.
      if (/cancel/i.test(message)) return;
      deps.notify(`Could not save ${name}. ${message || "Something went wrong."}`.trim());
    }
  }

  return {
    // Returns false for messages that are not download traffic, so the
    // caller can route other webview messages elsewhere.
    async handleMessage(detail: unknown): Promise<boolean> {
      const msg = detail as { type?: unknown; name?: unknown; mime?: unknown; data?: unknown; message?: unknown } | null;
      if (!msg || typeof msg !== "object") return false;
      if (msg.type === "odm-download-error") {
        deps.notify(str(msg.message, MAX_MESSAGE_LENGTH) || "The download failed.");
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
