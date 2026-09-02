// Native side of the Web Bluetooth bridge for the game webview. The Android
// System WebView has no navigator.bluetooth, so the shell injects a polyfill
// (ble-polyfill.ts) into the game page; that polyfill sends GATT operations
// here as JSON-safe RPC messages over the InAppBrowser postMessage channel,
// and this relay executes them against the native BLE plugin and streams
// notification and disconnect events back. Dependencies are injected so
// tests can drive the whole protocol against fakes; bridge.ts wires the
// real BleClient, InAppBrowser and Preferences in.

export interface BleDeviceInfo {
  deviceId: string;
  name?: string;
}

// Characteristic properties are omitted on purpose: the Pixels library never
// reads them, and leaving them out keeps this interface structurally
// assignable from the real BleClient.
export interface BleServiceInfo {
  uuid: string;
  characteristics: { uuid: string }[];
}

// The slice of @capacitor-community/bluetooth-le's BleClient the relay uses.
export interface NativeBle {
  initialize(options?: { androidNeverForLocation?: boolean }): Promise<void>;
  requestDevice(options?: {
    services?: string[];
    namePrefix?: string;
    optionalServices?: string[];
  }): Promise<BleDeviceInfo>;
  getDevices(deviceIds: string[]): Promise<BleDeviceInfo[]>;
  connect(deviceId: string, onDisconnect?: (deviceId: string) => void): Promise<void>;
  disconnect(deviceId: string): Promise<void>;
  getServices(deviceId: string): Promise<BleServiceInfo[]>;
  read(deviceId: string, service: string, characteristic: string): Promise<DataView>;
  write(deviceId: string, service: string, characteristic: string, value: DataView): Promise<void>;
  writeWithoutResponse(
    deviceId: string,
    service: string,
    characteristic: string,
    value: DataView,
  ): Promise<void>;
  startNotifications(
    deviceId: string,
    service: string,
    characteristic: string,
    callback: (value: DataView) => void,
  ): Promise<void>;
  stopNotifications(deviceId: string, service: string, characteristic: string): Promise<void>;
}

export interface BleRelayDeps {
  ble: NativeBle;
  // Delivers a message to the webview (InAppBrowser.postMessage detail).
  send(detail: Record<string, unknown>): void;
  // Devices the user granted via the picker, persisted so the game's silent
  // reconnect (navigator.bluetooth.getDevices) works across app runs.
  loadGranted(): Promise<string[]>;
  saveGranted(ids: string[]): Promise<void>;
}

const MAX_GRANTED = 16;

// The values crossing the channel are JSON only, so bytes ride as base64.
export function dataViewToB64(view: DataView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}

export function b64ToDataView(b64: string): DataView {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return new DataView(bytes.buffer);
}

// Everything arriving from the webview is untrusted page input: coerce and cap.
function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function uuidList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => str(entry, 40).toLowerCase())
    .filter((entry) => entry.length > 0)
    .slice(0, 16);
}

export function createBleRelay(deps: BleRelayDeps): {
  handleMessage(detail: unknown): Promise<boolean>;
} {
  const { ble, send } = deps;
  let ready: Promise<void> | null = null;
  const init = (): Promise<void> => {
    // BLE scanning never locates the player; declaring that skips the
    // location permission prompt on Android 12+.
    ready ??= ble.initialize({ androidNeverForLocation: true });
    return ready;
  };

  const rememberGranted = async (deviceId: string): Promise<void> => {
    const ids = await deps.loadGranted();
    const next = [deviceId, ...ids.filter((id) => id !== deviceId)].slice(0, MAX_GRANTED);
    await deps.saveGranted(next);
  };

  const summary = (device: BleDeviceInfo): Record<string, unknown> => ({
    deviceId: device.deviceId,
    name: device.name ?? "",
  });

  const onDisconnect = (deviceId: string): void => {
    send({ odmBle: "event", kind: "disconnect", deviceId });
  };

  const methods: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
    async requestDevice(params) {
      await init();
      const device = await ble.requestDevice({
        services: uuidList(params.services),
        namePrefix: str(params.namePrefix, 40) || undefined,
        optionalServices: uuidList(params.optionalServices),
      });
      await rememberGranted(device.deviceId);
      return summary(device);
    },
    async getDevices() {
      await init();
      const ids = await deps.loadGranted();
      if (ids.length === 0) return [];
      const devices = await ble.getDevices(ids);
      return devices.map(summary);
    },
    async connect(params) {
      await init();
      await ble.connect(str(params.deviceId, 100), onDisconnect);
      return null;
    },
    async disconnect(params) {
      await ble.disconnect(str(params.deviceId, 100));
      return null;
    },
    async getServices(params) {
      const services = await ble.getServices(str(params.deviceId, 100));
      return services.map((service) => ({
        uuid: service.uuid,
        characteristics: service.characteristics.map((entry) => ({ uuid: entry.uuid })),
      }));
    },
    async read(params) {
      const value = await ble.read(
        str(params.deviceId, 100),
        str(params.service, 40),
        str(params.characteristic, 40),
      );
      return { valueB64: dataViewToB64(value) };
    },
    async write(params) {
      const value = b64ToDataView(str(params.valueB64, 2048));
      const target = [
        str(params.deviceId, 100),
        str(params.service, 40),
        str(params.characteristic, 40),
      ] as const;
      if (params.withResponse === false) {
        await ble.writeWithoutResponse(...target, value);
      } else {
        await ble.write(...target, value);
      }
      return null;
    },
    async startNotifications(params) {
      const deviceId = str(params.deviceId, 100);
      const service = str(params.service, 40);
      const characteristic = str(params.characteristic, 40);
      await ble.startNotifications(deviceId, service, characteristic, (value) => {
        send({
          odmBle: "event",
          kind: "notify",
          deviceId,
          service,
          characteristic,
          valueB64: dataViewToB64(value),
        });
      });
      return null;
    },
    async stopNotifications(params) {
      await ble.stopNotifications(
        str(params.deviceId, 100),
        str(params.service, 40),
        str(params.characteristic, 40),
      );
      return null;
    },
  };

  return {
    // Returns false for messages that are not BLE RPCs, so the caller can
    // route other webview traffic elsewhere.
    async handleMessage(detail: unknown): Promise<boolean> {
      const msg = detail as { odmBle?: unknown; id?: unknown; method?: unknown; params?: unknown };
      if (!msg || msg.odmBle !== "rpc" || typeof msg.id !== "number") return false;
      const method = methods[str(msg.method, 40)];
      const params =
        msg.params && typeof msg.params === "object" ? (msg.params as Record<string, unknown>) : {};
      if (!method) {
        send({
          odmBle: "reply",
          id: msg.id,
          ok: false,
          error: { name: "NotSupportedError", message: "Unknown BLE call." },
        });
        return true;
      }
      try {
        const value = await method(params);
        send({ odmBle: "reply", id: msg.id, ok: true, value });
      } catch (err) {
        const name =
          err instanceof Error && err.name && err.name !== "Error" ? err.name : "NetworkError";
        const message = err instanceof Error ? err.message : "Bluetooth operation failed.";
        send({ odmBle: "reply", id: msg.id, ok: false, error: { name, message } });
      }
      return true;
    },
  };
}
