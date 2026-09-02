// The Web Bluetooth device picker: a list of what the scan sees, fed by the
// main process over window.odmBluetooth. Compiled as a classic script like
// app.ts, so the preload bridge is reached through a cast, not a global
// type augmentation.

interface OdmBluetoothBridge {
  onDevices(listener: (devices: { deviceId: string; deviceName: string }[]) => void): void;
  select(deviceId: string): void;
  cancel(): void;
}

const odmBluetooth = (window as unknown as { odmBluetooth: OdmBluetoothBridge }).odmBluetooth;

const pickerRoot = document.getElementById("app") as HTMLDivElement;

function pickerRender(devices: { deviceId: string; deviceName: string }[]): void {
  const title = document.createElement("h2");
  title.textContent = "Connect a Bluetooth die";
  const sub = document.createElement("p");
  sub.className = "sub";
  sub.textContent = "Pick the die to connect. Rolling it wakes it up.";
  const choices = document.createElement("div");
  choices.className = "choices";
  for (const device of devices) {
    const btn = document.createElement("button");
    btn.className = "choice";
    const name = document.createElement("span");
    name.className = "title";
    name.textContent = device.deviceName;
    btn.append(name);
    btn.addEventListener("click", () => odmBluetooth.select(device.deviceId));
    choices.append(btn);
  }
  const searching = document.createElement("p");
  searching.className = "hint";
  searching.textContent = devices.length === 0 ? "Searching nearby..." : "Still searching...";
  const cancel = document.createElement("button");
  cancel.className = "ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => odmBluetooth.cancel());
  pickerRoot.replaceChildren(title, sub, choices, searching, cancel);
}

pickerRender([]);
odmBluetooth.onDevices((devices) => pickerRender(devices));
