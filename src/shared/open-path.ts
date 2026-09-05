// Where a host opens when the shell attaches it.
//
// The home screen can land a player on a specific page of a host (a
// campaign, the character library, the dashboard with the wizard open)
// instead of the root. That path arrives from the renderer over IPC, and the
// renderer is untrusted input, so it is reduced to a plain same-origin path
// before it reaches a URL: absolute, no scheme, no protocol-relative "//",
// no backslashes, a bounded length. A join code still wins, because an
// invite always lands on /join.

const PATH_SHAPE = /^\/(?!\/)[A-Za-z0-9._~\-/?=&%]*$/;
const MAX_PATH = 200;

export function safeInnerPath(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_PATH) return "";
  return PATH_SHAPE.test(value) ? value : "";
}

export function landingPath(joinCode: string, path: unknown = ""): string {
  if (joinCode) return `/join/${joinCode}`;
  return safeInnerPath(path) || "/";
}
