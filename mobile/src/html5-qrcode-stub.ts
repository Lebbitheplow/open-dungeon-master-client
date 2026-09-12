// Stands in for html5-qrcode in the Android bridge bundle (build-www.mjs).
// @capacitor/barcode-scanner only reaches that library from its browser
// fallback, which never runs on the device, but its type-hint enum is
// spread from the library's format enum, so those values are kept.
export const Html5QrcodeSupportedFormats = {
  QR_CODE: 0,
  AZTEC: 1,
  CODABAR: 2,
  CODE_39: 3,
  CODE_93: 4,
  CODE_128: 5,
  DATA_MATRIX: 6,
  MAXICODE: 7,
  ITF: 8,
  EAN_13: 9,
  EAN_8: 10,
  PDF_417: 11,
  RSS_14: 12,
  RSS_EXPANDED: 13,
  UPC_A: 14,
  UPC_E: 15,
  UPC_EAN_EXTENSION: 16,
} as const;

export class Html5Qrcode {
  constructor() {
    throw new Error("The browser scanner is not bundled in the app.");
  }
}
