import type { OdmBridge } from "../../src/shared/types";
import type { NativeDictation } from "./dictation-core";

declare global {
  interface Window {
    odm: OdmBridge;
    // Which host's screens are mounted, set by the shared renderer
    // (src/renderer/game-screen.ts) for the document opener.
    odmMountedHostId?: string;
    // The shell's contour backdrop (src/renderer/topo.ts), paused under a
    // running world.
    odmTopo?: { pause(): void; resume(): void };
    // The phone's speech recognizer, offered to the game's dictation
    // button (src/dictation-core.ts).
    odmDictation?: NativeDictation;
  }
}

export {};
