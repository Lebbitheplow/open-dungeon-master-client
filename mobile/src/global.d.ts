import type { OdmBridge } from "../../src/shared/types";

declare global {
  interface Window {
    odm: OdmBridge;
  }
}

export {};
