// The three faces of the design, by @fontsource package: Cinzel for titles,
// Geist for the interface, Source Serif for everything the story says (the
// chronicle, the handout scroll, the book). The server gets them from
// next/font; the apps carry their own copies so a packaged app needs no
// network for its type.
export const FONT_PACKAGES = {
  "@fontsource/cinzel": ["cinzel-latin-400-normal.woff2", "cinzel-latin-600-normal.woff2", "cinzel-latin-700-normal.woff2"],
  "@fontsource/geist-sans": ["geist-sans-latin-400-normal.woff2", "geist-sans-latin-500-normal.woff2", "geist-sans-latin-600-normal.woff2"],
  "@fontsource/source-serif-4": [
    "source-serif-4-latin-400-normal.woff2",
    "source-serif-4-latin-400-italic.woff2",
    "source-serif-4-latin-600-normal.woff2",
    "source-serif-4-latin-600-italic.woff2",
  ],
};
export const FONT_FILES = Object.values(FONT_PACKAGES).flat();
