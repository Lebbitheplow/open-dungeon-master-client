// The built-in art the app carries (scripts/build-renderer.mjs copies the
// server's public folders beside the game bundle and inlines a manifest of
// them here): a host path the manifest lists resolves to the app's own file
// whether or not a host is connected, offline, and without a round trip to
// the host for each one in a world. A path it does not list (a host newer
// than the app) goes to the host as before.
import manifest from "odm:local-assets";
import { createLocalAssetIndex } from "../../shared/local-assets.js";

const index = createLocalAssetIndex(manifest);

export function localAsset(value: string): string | null {
  const rel = index.localPath(value);
  return rel ? new URL(rel, document.baseURI).href : null;
}
