// Which fetches from a host page belong to the host. A page written for
// the server asks for "/api/..." and expects its own origin to answer; in
// the app that origin is the shell's page (file:// on desktop, the
// Capacitor origin on Android), so the call is redirected to the host. A
// Request object always carries an absolute URL, resolved against the page
// when it was made, so the page's own origin is recognised as well.

// The host path (pathname plus query) for a URL the page meant as its own,
// or null for an address somewhere else.
export function hostRelativePath(url: string, baseURI: string): string | null {
  if (url.startsWith("/")) return url.startsWith("//") ? null : url;
  let target: URL;
  let base: URL;
  try {
    base = new URL(baseURI);
    target = new URL(url, base);
  } catch {
    return null;
  }
  if (target.protocol === "file:") {
    if (base.protocol !== "file:") return null;
  } else if (target.origin !== base.origin || target.origin === "null") {
    return null;
  }
  return `${target.pathname}${target.search}`;
}
