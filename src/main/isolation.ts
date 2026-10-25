import { net, type Session } from "electron";

// The app's own pages are cross-origin isolated, so an addon's board view
// whose threads permission its server accepted gets shared memory between
// its threads here as it does in a browser on that server. A file:// page
// cannot send headers of its own, so they are added to every file the app's
// own session loads.
//
// credentialless, not require-corp: what the game screens load straight from
// a host is its public files (everything behind the login is fetched with
// the token), which need nothing new. The board view frame is credentialless
// (the server's AddonBoardView.tsx), which is what lets it load inside these
// pages from a server of any version; without it a server older than the
// frame's own embedder policy would have its view refused.
export const ISOLATION_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["Cross-Origin-Opener-Policy", "same-origin"],
  ["Cross-Origin-Embedder-Policy", "credentialless"],
];

// The same response, with the two headers.
export function withIsolation(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of ISOLATION_HEADERS) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Every file:// load in this session, answered as before with the headers
// added. A file that is not there still fails as it did.
export function isolateShellPages(session: Session): void {
  session.protocol.handle("file", async (request) => withIsolation(await net.fetch(request, { bypassCustomProtocolHandlers: true })));
}
