import type { OdmBridge } from "../shared/types";

declare global {
  interface Window {
    odm: OdmBridge;
  }
}

export {};
