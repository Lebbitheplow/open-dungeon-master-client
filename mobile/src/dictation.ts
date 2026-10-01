import { registerPlugin } from "@capacitor/core";
import { installNativeDictation, type DictationPlugin } from "./dictation-core";

// The native half lives in android/.../DictationPlugin.java.
const OdmDictation = registerPlugin<DictationPlugin>("OdmDictation");

// Called once at startup: asks the phone for a speech recognizer and, when
// it has one, hands it to the game's screens.
export function offerNativeDictation(): void {
  void installNativeDictation(OdmDictation, window);
}
