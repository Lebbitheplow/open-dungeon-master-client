import { Capacitor, registerPlugin } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { MAX_DOWNLOAD_BYTES } from "./download-shim-core";
import { DOWNLOAD_FOLDER, INCOMING_NAME, sanitizeFilename, type NativeFetchResult } from "./download-relay";

// The app's own streaming download (android/.../DownloadPlugin.java): a
// host file goes straight from the socket to the app cache, with the
// WebView's cookies for that address and whatever headers the caller adds.
// Before this, a file crossed into Java as base64, back to this page
// through the plugin, and into Filesystem.writeFile as base64 again; five
// copies of a 40 MB export at once.

export interface NativeFetchOptions {
  url: string;
  headers?: Record<string, string>;
  // One path segment each, under the app cache directory.
  folder: string;
  fileName: string;
  // Bytes; the plugin never goes past its own 40 MB either way.
  maxBytes?: number;
}

export interface NativeFetchReply {
  // A file:// uri.
  path: string;
  size: number;
  // Without parameters, lower case, "" when the server sent none.
  mimeType: string;
  // What Content-Disposition called the file, "" without one.
  suggestedName: string;
}

export interface OdmDownloadPlugin {
  fetchToFile(options: NativeFetchOptions): Promise<NativeFetchReply>;
}

export const OdmDownload = registerPlugin<OdmDownloadPlugin>("OdmDownload");

// The download relay's native half: the file lands under a fixed name and
// the relay renames it once it has decided what to call it.
export async function fetchIncoming(
  plugin: OdmDownloadPlugin,
  url: string,
  headers: Record<string, string>,
): Promise<NativeFetchResult> {
  const reply = await plugin.fetchToFile({
    url,
    headers,
    folder: DOWNLOAD_FOLDER,
    fileName: INCOMING_NAME,
    maxBytes: MAX_DOWNLOAD_BYTES,
  });
  return { size: reply.size, mime: reply.mimeType, suggestedName: reply.suggestedName };
}

export async function renameIncoming(from: string, to: string): Promise<string> {
  await Filesystem.rename({ from, to, directory: Directory.Cache });
  return (await Filesystem.getUri({ path: to, directory: Directory.Cache })).uri;
}

// Home covers: fetched with the host's session into their own cache
// folder and handed to the page as an address the WebView can draw
// (Capacitor serves app files under its own origin), so no cover is ever
// base64 in memory. The folder is swept once per run; the page keeps its
// answers per run too (src/renderer/home.ts).
export const COVER_FOLDER = "odm-covers";

export function coverFileName(hostId: string, url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Not an address; the plugin will refuse it anyway.
  }
  return sanitizeFilename(`${hostId} ${path}`.replace(/[\\/]+/g, "-"), "");
}

export async function fetchCover(
  plugin: OdmDownloadPlugin,
  input: { hostId: string; url: string; token: string; maxBytes: number },
): Promise<string> {
  const reply = await plugin.fetchToFile({
    url: input.url,
    headers: { authorization: `Bearer ${input.token}` },
    folder: COVER_FOLDER,
    fileName: coverFileName(input.hostId, input.url),
    maxBytes: input.maxBytes,
  });
  if (!/^image\/[a-z0-9.+-]+$/.test(reply.mimeType)) return "";
  return Capacitor.convertFileSrc(reply.path);
}

export function sweepCovers(): void {
  void Filesystem.rmdir({ path: COVER_FOLDER, directory: Directory.Cache, recursive: true }).catch(
    () => undefined,
  );
}
