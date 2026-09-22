// The manifest of built-in art shipped beside the game bundle, generated at
// build time by scripts/build-renderer.mjs (localAssetsPlugin) and inlined
// into game.js so the first pictures already resolve locally.
declare module "odm:local-assets" {
  const manifest: Record<string, string[]>;
  export default manifest;
}
