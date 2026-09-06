// The renderer's view of the game router; the logic lives in the shared
// module so the tests can drive it without a DOM.
export { GameRouter, isAbsoluteUrl, matchRoute } from "../../shared/game-router.js";
export type { GameLocation } from "../../shared/game-router.js";
