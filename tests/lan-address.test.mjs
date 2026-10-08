import assert from "node:assert/strict";
import test from "node:test";
import { lanAddresses, lanOrigin } from "../dist/shared/lan.js";

const v4 = (address, internal = false) => ({ address, family: "IPv4", internal });
const v6 = (address) => ({ address, family: "IPv6", internal: false });

test("the Wi-Fi address is the private IPv4 one, never loopback, IPv6 or link-local", () => {
  const interfaces = {
    lo: [v4("127.0.0.1", true), v6("::1")],
    wlp3s0: [v4("169.254.10.4"), v6("fe80::1"), v4("192.168.1.128")],
  };
  assert.deepEqual(lanAddresses(interfaces), ["192.168.1.128"]);
  assert.equal(lanOrigin(interfaces, 3210), "http://192.168.1.128:3210");
});

test("container bridges and virtual pairs are left out; a public address lists after private ones", () => {
  const interfaces = {
    docker0: [v4("172.17.0.1")],
    "br-1a2b3c": [v4("172.18.0.1")],
    veth12ab: [v4("10.99.0.2")],
    vboxnet0: [v4("192.168.56.1")],
    eth0: [v4("203.0.113.5")],
    wlan0: [v4("10.0.0.7")],
  };
  assert.deepEqual(lanAddresses(interfaces), ["10.0.0.7", "203.0.113.5"]);
  assert.equal(lanOrigin(interfaces, 3210), "http://10.0.0.7:3210");
});

test("no network means no address, and Node's numeric family is understood", () => {
  assert.equal(lanOrigin({ lo: [v4("127.0.0.1", true)] }, 3210), "");
  assert.equal(lanOrigin({}, 3210), "");
  assert.equal(lanOrigin({ eth0: [{ address: "192.168.0.9", family: 4, internal: false }] }, 0), "");
  assert.deepEqual(lanAddresses({ eth0: [{ address: "192.168.0.9", family: 4, internal: false }] }), ["192.168.0.9"]);
});
