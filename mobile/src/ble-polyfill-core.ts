import { b64ToDataView, dataViewToB64 } from "./ble-relay";

// Browser side of the Web Bluetooth bridge: a navigator.bluetooth stand-in
// for the game webview, relaying every GATT operation to the shell over the
// InAppBrowser message channel (ble-relay.ts executes them natively).
//
// The surface is deliberately exactly what @systemic-games/pixels-web-connect
// touches, verified against its sources:
// - navigator.bluetooth.requestDevice / getDevices, nothing else
// - device: id, name, gatt, add/removeEventListener("gattserverdisconnected")
// - gatt: connect, disconnect, connected, getPrimaryService (singular)
// - service: getCharacteristic (singular)
// - characteristic: startNotifications, writeValueWithResponse,
//   writeValueWithoutResponse, value, "characteristicvaluechanged"
// watchAdvertisements is intentionally absent: its truthiness enables a
// rescan fallback in the library that this bridge cannot honor.
//
// Devices and characteristics extend the real EventTarget because the
// library reads notification payloads off `this.value` inside a plain
// function listener, and add/removeEventListener must dedupe and remove by
// function identity; EventTarget gives all three semantics for free.

export interface BleBridgeTransport {
  send(message: Record<string, unknown>): void;
  onMessage(listener: (message: Record<string, unknown>) => void): void;
}

interface ServiceShape {
  uuid: string;
  characteristics: { uuid: string }[];
}

function bleError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

function uuidOf(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function toDataView(data: ArrayBuffer | ArrayBufferView): DataView {
  if (data instanceof ArrayBuffer) return new DataView(data);
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

export function createWebBluetooth(transport: BleBridgeTransport): {
  requestDevice(options?: unknown): Promise<unknown>;
  getDevices(): Promise<unknown[]>;
} {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      transport.send({ odmBle: "rpc", id, method, params });
    });
  }

  const devices = new Map<string, PolyfillDevice>();
  // deviceId|characteristicUuid -> the characteristic notifications target.
  const notifyTargets = new Map<string, PolyfillCharacteristic>();

  class PolyfillCharacteristic extends EventTarget {
    readonly service: PolyfillService;
    readonly uuid: string;
    value: DataView | null = null;

    constructor(service: PolyfillService, uuid: string) {
      super();
      this.service = service;
      this.uuid = uuid;
    }

    private target(): Record<string, unknown> {
      return {
        deviceId: this.service.device.id,
        service: this.service.uuid,
        characteristic: this.uuid,
      };
    }

    async startNotifications(): Promise<PolyfillCharacteristic> {
      await rpc("startNotifications", this.target());
      notifyTargets.set(`${this.service.device.id}|${this.uuid}`, this);
      return this;
    }

    async stopNotifications(): Promise<PolyfillCharacteristic> {
      notifyTargets.delete(`${this.service.device.id}|${this.uuid}`);
      await rpc("stopNotifications", this.target());
      return this;
    }

    async readValue(): Promise<DataView> {
      const reply = await rpc<{ valueB64?: unknown }>("read", this.target());
      this.value = b64ToDataView(String(reply?.valueB64 ?? ""));
      return this.value;
    }

    async writeValueWithResponse(data: ArrayBuffer | ArrayBufferView): Promise<void> {
      await rpc("write", {
        ...this.target(),
        valueB64: dataViewToB64(toDataView(data)),
        withResponse: true,
      });
    }

    async writeValueWithoutResponse(data: ArrayBuffer | ArrayBufferView): Promise<void> {
      await rpc("write", {
        ...this.target(),
        valueB64: dataViewToB64(toDataView(data)),
        withResponse: false,
      });
    }
  }

  class PolyfillService {
    readonly device: PolyfillDevice;
    readonly uuid: string;
    private readonly characteristicUuids: string[];
    private readonly characteristics = new Map<string, PolyfillCharacteristic>();

    constructor(device: PolyfillDevice, uuid: string, characteristicUuids: string[]) {
      this.device = device;
      this.uuid = uuid;
      this.characteristicUuids = characteristicUuids;
    }

    async getCharacteristic(uuid: unknown): Promise<PolyfillCharacteristic> {
      const clean = uuidOf(uuid);
      if (!this.characteristicUuids.includes(clean)) {
        throw bleError("NotFoundError", `No characteristic ${clean} in service ${this.uuid}.`);
      }
      let characteristic = this.characteristics.get(clean);
      if (!characteristic) {
        characteristic = new PolyfillCharacteristic(this, clean);
        this.characteristics.set(clean, characteristic);
      }
      return characteristic;
    }
  }

  class PolyfillGatt {
    readonly device: PolyfillDevice;
    connected = false;
    private discovered: Map<string, string[]> | null = null;
    private readonly services = new Map<string, PolyfillService>();

    constructor(device: PolyfillDevice) {
      this.device = device;
    }

    async connect(): Promise<PolyfillGatt> {
      if (!this.connected) {
        await rpc("connect", { deviceId: this.device.id });
        this.connected = true;
      }
      return this;
    }

    // Synchronous like the real API; the library never awaits it. The
    // gattserverdisconnected event arrives from the native side once the
    // disconnect lands, so it fires exactly once either way.
    disconnect(): void {
      if (!this.connected) return;
      this.dropConnection();
      void rpc("disconnect", { deviceId: this.device.id }).catch(() => undefined);
    }

    dropConnection(): void {
      this.connected = false;
      this.discovered = null;
    }

    async getPrimaryService(uuid: unknown): Promise<PolyfillService> {
      const clean = uuidOf(uuid);
      if (!this.connected) {
        throw bleError("NetworkError", "GATT Server is disconnected.");
      }
      if (!this.discovered) {
        const list = await rpc<ServiceShape[]>("getServices", { deviceId: this.device.id });
        this.discovered = new Map(
          (Array.isArray(list) ? list : []).map((entry) => [
            uuidOf(entry.uuid),
            entry.characteristics.map((c) => uuidOf(c.uuid)),
          ]),
        );
      }
      const characteristicUuids = this.discovered.get(clean);
      if (!characteristicUuids) {
        throw bleError("NotFoundError", `No service ${clean} on this device.`);
      }
      let service = this.services.get(clean);
      if (!service) {
        service = new PolyfillService(this.device, clean, characteristicUuids);
        this.services.set(clean, service);
      }
      return service;
    }
  }

  class PolyfillDevice extends EventTarget {
    readonly id: string;
    readonly name: string;
    readonly gatt: PolyfillGatt;

    constructor(id: string, name: string) {
      super();
      this.id = id;
      this.name = name;
      this.gatt = new PolyfillGatt(this);
    }
  }

  // Same object per device id, so the library's identity assumptions hold.
  function deviceFor(info: { deviceId?: unknown; name?: unknown }): PolyfillDevice {
    const id = String(info?.deviceId ?? "");
    let device = devices.get(id);
    if (!device) {
      device = new PolyfillDevice(id, String(info?.name ?? ""));
      devices.set(id, device);
    }
    return device;
  }

  transport.onMessage((message) => {
    if (message.odmBle === "reply" && typeof message.id === "number") {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.ok) {
        waiter.resolve(message.value);
      } else {
        const error = message.error as { name?: unknown; message?: unknown } | undefined;
        waiter.reject(
          bleError(
            String(error?.name ?? "NetworkError"),
            String(error?.message ?? "Bluetooth operation failed."),
          ),
        );
      }
      return;
    }
    if (message.odmBle !== "event") return;
    const deviceId = String(message.deviceId ?? "");
    if (message.kind === "notify") {
      const target = notifyTargets.get(`${deviceId}|${uuidOf(message.characteristic)}`);
      if (!target) return;
      // A fresh, exactly-sized buffer per notification: the library guards
      // on value.buffer.byteLength and reads from offset 0.
      target.value = b64ToDataView(String(message.valueB64 ?? ""));
      target.dispatchEvent(new Event("characteristicvaluechanged"));
    } else if (message.kind === "disconnect") {
      const device = devices.get(deviceId);
      if (!device || !device.gatt.connected) return;
      device.gatt.dropConnection();
      device.dispatchEvent(new Event("gattserverdisconnected"));
    }
  });

  return {
    async requestDevice(options?: unknown): Promise<unknown> {
      const opts = options as
        | { filters?: { services?: unknown[]; namePrefix?: unknown }[]; optionalServices?: unknown[] }
        | undefined;
      const services: string[] = [];
      let namePrefix = "";
      for (const filter of Array.isArray(opts?.filters) ? opts.filters : []) {
        for (const service of Array.isArray(filter?.services) ? filter.services : []) {
          const clean = uuidOf(service);
          if (clean && !services.includes(clean)) services.push(clean);
        }
        if (!namePrefix && typeof filter?.namePrefix === "string") namePrefix = filter.namePrefix;
      }
      const optionalServices = (Array.isArray(opts?.optionalServices) ? opts.optionalServices : [])
        .map(uuidOf)
        .filter((entry) => entry.length > 0);
      const reply = await rpc<{ deviceId?: unknown; name?: unknown }>("requestDevice", {
        services,
        namePrefix,
        optionalServices,
      });
      return deviceFor(reply);
    },

    // Must return a real Array: the library calls .find on it.
    async getDevices(): Promise<unknown[]> {
      const reply = await rpc<{ deviceId?: unknown; name?: unknown }[]>("getDevices");
      return (Array.isArray(reply) ? reply : []).map(deviceFor);
    },
  };
}
