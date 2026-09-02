import assert from "node:assert/strict";
import test from "node:test";
import {
  b64ToDataView,
  createBleRelay,
  dataViewToB64,
  type BleRelayDeps,
  type NativeBle,
} from "../src/ble-relay";

// A recording fake of the native BLE plugin plus the surrounding wiring, so
// every test drives the real RPC protocol end to end without hardware.

interface Harness {
  relay: ReturnType<typeof createBleRelay>;
  sent: Record<string, unknown>[];
  calls: string[];
  granted: string[];
  ble: NativeBle & {
    notifyCallback: ((value: DataView) => void) | null;
    disconnectCallback: ((deviceId: string) => void) | null;
  };
}

function makeHarness(overrides: Partial<NativeBle> = {}): Harness {
  const sent: Record<string, unknown>[] = [];
  const calls: string[] = [];
  let granted: string[] = [];
  const ble: Harness["ble"] = {
    notifyCallback: null,
    disconnectCallback: null,
    async initialize() {
      calls.push("initialize");
    },
    async requestDevice(options) {
      calls.push(`requestDevice ${JSON.stringify(options)}`);
      return { deviceId: "AA:BB", name: "Pixel d20" };
    },
    async getDevices(ids) {
      calls.push(`getDevices ${ids.join(",")}`);
      return ids.map((deviceId) => ({ deviceId, name: `die ${deviceId}` }));
    },
    async connect(deviceId, onDisconnect) {
      calls.push(`connect ${deviceId}`);
      ble.disconnectCallback = onDisconnect ?? null;
    },
    async disconnect(deviceId) {
      calls.push(`disconnect ${deviceId}`);
    },
    async getServices(deviceId) {
      calls.push(`getServices ${deviceId}`);
      return [{ uuid: "svc-1", characteristics: [{ uuid: "char-1" }] }];
    },
    async read() {
      return new DataView(Uint8Array.from([1, 2, 3]).buffer);
    },
    async write(deviceId, service, characteristic, value) {
      calls.push(`write ${dataViewToB64(value)}`);
    },
    async writeWithoutResponse(deviceId, service, characteristic, value) {
      calls.push(`writeWithoutResponse ${dataViewToB64(value)}`);
    },
    async startNotifications(deviceId, service, characteristic, callback) {
      calls.push(`startNotifications ${deviceId} ${service} ${characteristic}`);
      ble.notifyCallback = callback;
    },
    async stopNotifications(deviceId, service, characteristic) {
      calls.push(`stopNotifications ${deviceId} ${service} ${characteristic}`);
    },
    ...overrides,
  };
  const deps: BleRelayDeps = {
    ble,
    send: (detail) => sent.push(detail),
    loadGranted: async () => granted,
    saveGranted: async (ids) => {
      granted = ids;
    },
  };
  const harness: Harness = { relay: createBleRelay(deps), sent, calls, granted, ble };
  Object.defineProperty(harness, "granted", { get: () => granted });
  return harness;
}

function rpc(id: number, method: string, params: Record<string, unknown> = {}) {
  return { odmBle: "rpc", id, method, params };
}

test("base64 round-trips bytes exactly", () => {
  const view = new DataView(Uint8Array.from([0, 1, 127, 128, 255]).buffer);
  const back = b64ToDataView(dataViewToB64(view));
  assert.deepEqual(
    new Uint8Array(back.buffer),
    new Uint8Array(view.buffer),
  );
});

test("non-BLE messages are left for other handlers", async () => {
  const h = makeHarness();
  assert.equal(await h.relay.handleMessage({ action: "something-else" }), false);
  assert.equal(await h.relay.handleMessage(null), false);
  assert.equal(await h.relay.handleMessage({ odmBle: "rpc", id: "not-a-number" }), false);
  assert.equal(h.sent.length, 0);
});

test("requestDevice initializes once, filters services and remembers the grant", async () => {
  const h = makeHarness();
  await h.relay.handleMessage(
    rpc(1, "requestDevice", { services: ["SVC-UUID"], namePrefix: "Pixels" }),
  );
  await h.relay.handleMessage(rpc(2, "requestDevice", { services: ["svc-uuid"] }));
  assert.equal(h.calls.filter((c) => c === "initialize").length, 1);
  assert.ok(h.calls[1].includes('"services":["svc-uuid"]'), "uuids are lowercased");
  assert.ok(h.calls[1].includes('"namePrefix":"Pixels"'));
  assert.deepEqual(h.sent[0], {
    odmBle: "reply",
    id: 1,
    ok: true,
    value: { deviceId: "AA:BB", name: "Pixel d20" },
  });
  assert.deepEqual(h.granted, ["AA:BB"], "granted once despite two requests");
});

test("getDevices returns nothing before any grant, then the remembered dice", async () => {
  const h = makeHarness();
  await h.relay.handleMessage(rpc(1, "getDevices"));
  assert.deepEqual(h.sent[0], { odmBle: "reply", id: 1, ok: true, value: [] });
  assert.ok(!h.calls.some((c) => c.startsWith("getDevices")), "no lookup without grants");
  await h.relay.handleMessage(rpc(2, "requestDevice", {}));
  await h.relay.handleMessage(rpc(3, "getDevices"));
  assert.deepEqual(h.sent[2], {
    odmBle: "reply",
    id: 3,
    ok: true,
    value: [{ deviceId: "AA:BB", name: "die AA:BB" }],
  });
});

test("connect wires the disconnect event back to the webview", async () => {
  const h = makeHarness();
  await h.relay.handleMessage(rpc(1, "connect", { deviceId: "AA:BB" }));
  assert.deepEqual(h.sent[0], { odmBle: "reply", id: 1, ok: true, value: null });
  h.ble.disconnectCallback?.("AA:BB");
  assert.deepEqual(h.sent[1], { odmBle: "event", kind: "disconnect", deviceId: "AA:BB" });
});

test("getServices maps service and characteristic uuids through", async () => {
  const h = makeHarness();
  await h.relay.handleMessage(rpc(1, "getServices", { deviceId: "AA:BB" }));
  assert.deepEqual(h.sent[0], {
    odmBle: "reply",
    id: 1,
    ok: true,
    value: [{ uuid: "svc-1", characteristics: [{ uuid: "char-1" }] }],
  });
});

test("read replies with the value as base64", async () => {
  const h = makeHarness();
  await h.relay.handleMessage(rpc(1, "read", { deviceId: "d", service: "s", characteristic: "c" }));
  const reply = h.sent[0] as { value: { valueB64: string } };
  assert.deepEqual(new Uint8Array(b64ToDataView(reply.value.valueB64).buffer), Uint8Array.from([1, 2, 3]));
});

test("write decodes base64 and routes on withResponse", async () => {
  const h = makeHarness();
  const valueB64 = dataViewToB64(new DataView(Uint8Array.from([9, 8]).buffer));
  await h.relay.handleMessage(rpc(1, "write", { deviceId: "d", service: "s", characteristic: "c", valueB64 }));
  await h.relay.handleMessage(
    rpc(2, "write", { deviceId: "d", service: "s", characteristic: "c", valueB64, withResponse: false }),
  );
  assert.equal(h.calls[0], `write ${valueB64}`);
  assert.equal(h.calls[1], `writeWithoutResponse ${valueB64}`);
});

test("notifications stream as events with base64 payloads", async () => {
  const h = makeHarness();
  await h.relay.handleMessage(
    rpc(1, "startNotifications", { deviceId: "d", service: "s", characteristic: "c" }),
  );
  h.ble.notifyCallback?.(new DataView(Uint8Array.from([3, 1]).buffer));
  const event = h.sent[1] as { kind: string; valueB64: string; characteristic: string };
  assert.equal(event.kind, "notify");
  assert.equal(event.characteristic, "c");
  assert.deepEqual(new Uint8Array(b64ToDataView(event.valueB64).buffer), Uint8Array.from([3, 1]));
});

test("failures reply with a DOMException-style name for the polyfill", async () => {
  const h = makeHarness({
    async connect() {
      const err = new Error("die out of range");
      err.name = "TimeoutError";
      throw err;
    },
    async read() {
      throw new Error("plain failure");
    },
  });
  await h.relay.handleMessage(rpc(1, "connect", { deviceId: "x" }));
  assert.deepEqual(h.sent[0], {
    odmBle: "reply",
    id: 1,
    ok: false,
    error: { name: "TimeoutError", message: "die out of range" },
  });
  await h.relay.handleMessage(rpc(2, "read", {}));
  const reply = h.sent[1] as { error: { name: string } };
  assert.equal(reply.error.name, "NetworkError", "generic errors read as NetworkError");
});

test("unknown methods are refused, not crashed on", async () => {
  const h = makeHarness();
  await h.relay.handleMessage(rpc(7, "formatHardDrive"));
  const reply = h.sent[0] as { ok: boolean; error: { name: string } };
  assert.equal(reply.ok, false);
  assert.equal(reply.error.name, "NotSupportedError");
});
