import assert from "node:assert/strict";
import test from "node:test";
import { createWebBluetooth, type BleBridgeTransport } from "../src/ble-polyfill-core";
import { dataViewToB64 } from "../src/ble-relay";

// A scripted fake of the native relay. Each test drives the polyfill the
// way @systemic-games/pixels-web-connect does: same requestDevice filter
// shape, plain-function listeners that read this.value, singular lookups.

const LEGACY_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const LEGACY_NOTIFY = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const LEGACY_WRITE = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const DIE_SERVICE = "a6b90001-7a5a-43f2-a962-350c8edc9b5b";

interface Rpc {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface Fake {
  bluetooth: ReturnType<typeof createWebBluetooth>;
  rpcs: Rpc[];
  emit(message: Record<string, unknown>): void;
  failNext(method: string, name: string, message: string): void;
}

function makeFake(): Fake {
  let listener: ((message: Record<string, unknown>) => void) | null = null;
  const rpcs: Rpc[] = [];
  const failures = new Map<string, { name: string; message: string }>();

  const results: Record<string, (params: Record<string, unknown>) => unknown> = {
    requestDevice: () => ({ deviceId: "AA:BB:CC", name: "Pixel d20" }),
    getDevices: () => [{ deviceId: "AA:BB:CC", name: "Pixel d20" }],
    connect: () => null,
    disconnect: () => null,
    getServices: () => [
      {
        uuid: LEGACY_SERVICE,
        characteristics: [{ uuid: LEGACY_NOTIFY }, { uuid: LEGACY_WRITE }],
      },
      { uuid: DIE_SERVICE, characteristics: [] },
    ],
    startNotifications: () => null,
    stopNotifications: () => null,
    write: () => null,
    read: () => ({ valueB64: dataViewToB64(new DataView(Uint8Array.from([42]).buffer)) }),
  };

  const transport: BleBridgeTransport = {
    send(message) {
      const rpc = message as unknown as Rpc & { odmBle: string };
      rpcs.push({ id: rpc.id, method: rpc.method, params: rpc.params });
      const failure = failures.get(rpc.method);
      if (failure) {
        failures.delete(rpc.method);
        listener?.({ odmBle: "reply", id: rpc.id, ok: false, error: failure });
        return;
      }
      listener?.({ odmBle: "reply", id: rpc.id, ok: true, value: results[rpc.method]?.(rpc.params) });
    },
    onMessage(fn) {
      listener = fn;
    },
  };

  return {
    bluetooth: createWebBluetooth(transport),
    rpcs,
    emit: (message) => listener?.(message),
    failNext: (method, name, message) => failures.set(method, { name, message }),
  };
}

// The exact options object PixelsDevices.requestDevice passes.
const PIXELS_REQUEST = {
  filters: [{ services: [LEGACY_SERVICE] }, { services: [DIE_SERVICE] }],
};

interface DeviceLike {
  id: string;
  name: string;
  gatt: {
    connected: boolean;
    connect(): Promise<unknown>;
    disconnect(): void;
    getPrimaryService(uuid: string): Promise<ServiceLike>;
  };
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

interface ServiceLike {
  getCharacteristic(uuid: string): Promise<CharacteristicLike>;
}

interface CharacteristicLike {
  value: DataView | null;
  startNotifications(): Promise<unknown>;
  writeValueWithResponse(data: ArrayBuffer): Promise<void>;
  writeValueWithoutResponse(data: ArrayBuffer): Promise<void>;
  addEventListener(type: string, fn: (this: CharacteristicLike) => void): void;
  removeEventListener(type: string, fn: (this: CharacteristicLike) => void): void;
}

async function pairAndConnect(fake: Fake): Promise<DeviceLike> {
  const device = (await fake.bluetooth.requestDevice(PIXELS_REQUEST)) as DeviceLike;
  await device.gatt.connect();
  return device;
}

test("requestDevice folds the Pixels filters into one service list", async () => {
  const fake = makeFake();
  const device = (await fake.bluetooth.requestDevice(PIXELS_REQUEST)) as DeviceLike;
  assert.deepEqual(fake.rpcs[0].params, {
    services: [LEGACY_SERVICE, DIE_SERVICE],
    namePrefix: "",
    optionalServices: [],
  });
  assert.equal(device.id, "AA:BB:CC");
  assert.equal(device.name, "Pixel d20");
});

test("getDevices returns an Array with stable device identity", async () => {
  const fake = makeFake();
  const requested = await fake.bluetooth.requestDevice(PIXELS_REQUEST);
  const listed = await fake.bluetooth.getDevices();
  assert.ok(Array.isArray(listed));
  assert.equal(listed.length, 1);
  assert.equal(listed[0], requested, "same object for the same device id");
});

test("gatt connects, resolves services case-insensitively, rejects unknown ones", async () => {
  const fake = makeFake();
  const device = await pairAndConnect(fake);
  assert.equal(device.gatt.connected, true);
  const service = await device.gatt.getPrimaryService(LEGACY_SERVICE.toUpperCase());
  await service.getCharacteristic(LEGACY_WRITE.toUpperCase());
  await assert.rejects(
    () => device.gatt.getPrimaryService("0000feed-0000-1000-8000-00805f9b34fb"),
    (err: Error) => err.name === "NotFoundError",
  );
  await assert.rejects(
    () => service.getCharacteristic("0000dead-0000-1000-8000-00805f9b34fb"),
    (err: Error) => err.name === "NotFoundError",
  );
});

test("writes ride as base64 with the right response flag", async () => {
  const fake = makeFake();
  const device = await pairAndConnect(fake);
  const service = await device.gatt.getPrimaryService(LEGACY_SERVICE);
  const characteristic = await service.getCharacteristic(LEGACY_WRITE);
  // The library always hands over a plain, exactly-sized ArrayBuffer.
  await characteristic.writeValueWithoutResponse(Uint8Array.from([1, 3]).buffer);
  await characteristic.writeValueWithResponse(Uint8Array.from([2]).buffer);
  const writes = fake.rpcs.filter((rpc) => rpc.method === "write");
  assert.equal(writes[0].params.withResponse, false);
  assert.equal(writes[0].params.valueB64, dataViewToB64(new DataView(Uint8Array.from([1, 3]).buffer)));
  assert.equal(writes[1].params.withResponse, true);
});

test("notifications land on this.value inside a plain function listener", async () => {
  const fake = makeFake();
  const device = await pairAndConnect(fake);
  const service = await device.gatt.getPrimaryService(LEGACY_SERVICE);
  const characteristic = await service.getCharacteristic(LEGACY_NOTIFY);
  const seen: number[] = [];
  // Mirrors BleSession's internalListener: reads this.value, guards on
  // value.buffer.byteLength, never touches event.target.
  function onValueChanged(this: CharacteristicLike): void {
    if (this.value?.buffer?.byteLength) seen.push(this.value.getUint8(0));
  }
  characteristic.addEventListener("characteristicvaluechanged", onValueChanged);
  // Adding the same reference twice must not double-fire (DOM dedupe rule).
  characteristic.addEventListener("characteristicvaluechanged", onValueChanged);
  await characteristic.startNotifications();
  fake.emit({
    odmBle: "event",
    kind: "notify",
    deviceId: "AA:BB:CC",
    characteristic: LEGACY_NOTIFY,
    valueB64: dataViewToB64(new DataView(Uint8Array.from([17]).buffer)),
  });
  assert.deepEqual(seen, [17]);
  characteristic.removeEventListener("characteristicvaluechanged", onValueChanged);
  fake.emit({
    odmBle: "event",
    kind: "notify",
    deviceId: "AA:BB:CC",
    characteristic: LEGACY_NOTIFY,
    valueB64: dataViewToB64(new DataView(Uint8Array.from([3]).buffer)),
  });
  assert.deepEqual(seen, [17], "removed by function identity");
});

test("a native disconnect fires gattserverdisconnected exactly once", async () => {
  const fake = makeFake();
  const device = await pairAndConnect(fake);
  let fired = 0;
  device.addEventListener("gattserverdisconnected", () => {
    fired += 1;
  });
  fake.emit({ odmBle: "event", kind: "disconnect", deviceId: "AA:BB:CC" });
  fake.emit({ odmBle: "event", kind: "disconnect", deviceId: "AA:BB:CC" });
  assert.equal(fired, 1, "the duplicate event is swallowed");
  assert.equal(device.gatt.connected, false);
  await assert.rejects(
    () => device.gatt.getPrimaryService(LEGACY_SERVICE),
    (err: Error) => err.name === "NetworkError",
  );
});

test("an intentional gatt.disconnect sends the rpc and waits for the event", async () => {
  const fake = makeFake();
  const device = await pairAndConnect(fake);
  let fired = 0;
  device.addEventListener("gattserverdisconnected", () => {
    fired += 1;
  });
  device.gatt.disconnect();
  assert.equal(device.gatt.connected, false);
  assert.ok(fake.rpcs.some((rpc) => rpc.method === "disconnect"));
  assert.equal(fired, 0, "the event comes from the native side, not locally");
});

test("relay errors surface with their DOMException-style name", async () => {
  const fake = makeFake();
  fake.failNext("requestDevice", "NotFoundError", "User cancelled the chooser.");
  await assert.rejects(
    () => fake.bluetooth.requestDevice(PIXELS_REQUEST),
    (err: Error) => err.name === "NotFoundError" && err.message.includes("cancelled"),
  );
});

test("reconnect works after a drop: connect again rediscovers services", async () => {
  const fake = makeFake();
  const device = await pairAndConnect(fake);
  await device.gatt.getPrimaryService(LEGACY_SERVICE);
  fake.emit({ odmBle: "event", kind: "disconnect", deviceId: "AA:BB:CC" });
  await device.gatt.connect();
  assert.equal(device.gatt.connected, true);
  await device.gatt.getPrimaryService(LEGACY_SERVICE);
  const discoveries = fake.rpcs.filter((rpc) => rpc.method === "getServices");
  assert.equal(discoveries.length, 2, "service cache is dropped with the connection");
});
