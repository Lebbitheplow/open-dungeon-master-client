/* global document */
// "react-dom" as the game screens see it: Preact's compat layer, with one
// difference. A page that portals into document.body (the voice dock's
// sheet) would land outside .game-root, where the game's stylesheet does
// not reach (scripts/scope-css.mjs); those portals go to the game root
// instead, the same place the Radix portal shim uses.
import compat, { createPortal as compatPortal } from "preact/compat";

export * from "preact/compat";
export default compat;

export function createPortal(children, container) {
  const target =
    container === document.body ? (document.querySelector(".game-root") ?? container) : container;
  return compatPortal(children, target);
}
