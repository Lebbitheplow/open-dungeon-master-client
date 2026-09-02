import { contextBridge, ipcRenderer } from "electron";

// Bridge for the Web Bluetooth device picker window (Pixels dice pairing).
// Receive-and-answer only: the picker can see the scan results and pick or
// cancel, nothing else.

contextBridge.exposeInMainWorld("odmBluetooth", {
  onDevices: (listener: (devices: { deviceId: string; deviceName: string }[]) => void) => {
    ipcRenderer.on(
      "bluetooth:devices",
      (_event, devices: { deviceId: string; deviceName: string }[]) => listener(devices),
    );
  },
  select: (deviceId: string) => ipcRenderer.send("bluetooth:select", deviceId),
  cancel: () => ipcRenderer.send("bluetooth:cancel"),
});
