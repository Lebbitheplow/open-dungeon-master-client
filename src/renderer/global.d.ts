import type { OdmBridge } from "../shared/types";

declare global {
  interface Window {
    odm: OdmBridge;
    // The animated backdrop (topo.ts), paused by the shell off the home screen.
    odmTopo?: { pause(): void; resume(): void };
  }
}

export {};

