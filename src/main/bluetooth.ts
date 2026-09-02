import path from "node:path";
import { BrowserWindow, ipcMain, type Session, type WebContents } from "electron";
import { appIconPath } from "./app-icon";

// Web Bluetooth plumbing for the server view. The game UI pairs Pixels dice
// through navigator.bluetooth, but Electron ships no device chooser: without
// a select-bluetooth-device listener Chromium grabs the first device the
// scan finds. The shell owns a small picker window instead, fed with the
// scan results and handing the chosen device id back to Chromium.

interface DeviceRow {
  deviceId: string;
  deviceName: string;
}

let picker: BrowserWindow | null = null;
let choose: ((deviceId: string) => void) | null = null;
let latest: DeviceRow[] = [];
let ipcWired = false;

// Ends the request: hands Chromium the chosen id ("" cancels) and drops the
// picker. The closed handler below sees choose already cleared and stays put.
function finish(deviceId: string): void {
  const callback = choose;
  choose = null;
  latest = [];
  callback?.(deviceId);
  picker?.close();
}

function wirePickerIpc(): void {
  if (ipcWired) return;
  ipcWired = true;
  ipcMain.on("bluetooth:select", (_event, id: unknown) => {
    finish(typeof id === "string" ? id.slice(0, 200) : "");
  });
  ipcMain.on("bluetooth:cancel", () => finish(""));
}

function sendDevices(): void {
  picker?.webContents.send("bluetooth:devices", latest);
}

function ensurePicker(parent: BrowserWindow | null): void {
  if (picker) return;
  picker = new BrowserWindow({
    width: 400,
    height: 460,
    parent: parent ?? undefined,
    modal: parent !== null,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    backgroundColor: "#181420",
    icon: appIconPath(),
    title: "Connect a Bluetooth die",
    webPreferences: {
      preload: path.join(__dirname, "../preload/bluetooth-picker.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  picker.webContents.on("did-finish-load", sendDevices);
  picker.on("closed", () => {
    picker = null;
    // Closing the window by hand cancels the pending request.
    const callback = choose;
    choose = null;
    latest = [];
    callback?.("");
  });
  void picker.loadFile(path.join(__dirname, "../renderer/bluetooth-picker.html"));
}

// Attach to a server view's contents. Chromium re-fires the event with the
// full device list every time the scan learns something, so each firing just
// refreshes the picker.
export function wireBluetoothChooser(
  contents: WebContents,
  parent: () => BrowserWindow | null,
): void {
  wirePickerIpc();
  contents.on("select-bluetooth-device", (event, devices, callback) => {
    event.preventDefault();
    choose = callback;
    latest = devices.map((device) => ({
      deviceId: device.deviceId,
      deviceName: device.deviceName || "Unnamed device",
    }));
    ensurePicker(parent());
    sendDevices();
  });
  // Never invoke a callback whose webContents is gone.
  contents.once("destroyed", () => {
    if (choose) {
      choose = null;
      latest = [];
      picker?.close();
    }
  });
}

// Pixels dice bond without a PIN; confirmation-style prompts are safe to
// approve, and anything demanding a typed PIN is not a die, so decline it.
// The handler only exists on Windows and Linux; elsewhere the OS prompts.
export function autoConfirmBluetoothPairing(ses: Session): void {
  if (typeof ses.setBluetoothPairingHandler !== "function") return;
  ses.setBluetoothPairingHandler((details, callback) => {
    if (details.pairingKind === "confirm" || details.pairingKind === "confirmPin") {
      callback({ confirmed: true });
    } else {
      callback({ confirmed: false });
    }
  });
}
