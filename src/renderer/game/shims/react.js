// "react" as the game screens see it: Preact's compat layer plus the one
// React 19 addition it lacks. The bundler aliases react, react-dom and
// their JSX runtimes here (scripts/build-renderer.mjs), so the server's
// components run unchanged. Plain JavaScript because compat's typings are
// an `export =` module that TypeScript refuses to re-export from.
import compat from "preact/compat";

export * from "preact/compat";
export default compat;

// React 19's use(): the pages call it on the params promise Next hands
// them. The game router builds those promises with the value attached
// (params.ts), so they never suspend; any other thenable is thrown for
// the nearest Suspense boundary the way React does.
export function use(value) {
  if (value && typeof value === "object" && "__value" in value) return value.__value;
  throw value;
}
