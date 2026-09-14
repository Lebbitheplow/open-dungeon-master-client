import type { OdmBridge } from "../../src/shared/types";

declare global {
  interface Window {
    odm: OdmBridge;
    // Which host's screens are mounted, set by the shared renderer
    // (src/renderer/game-screen.ts) for the document opener.
    odmMountedHostId?: string;
  }
}

export {};
