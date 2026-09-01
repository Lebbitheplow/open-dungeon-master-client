import assert from "node:assert/strict";
import test from "node:test";
import { parseBrokerSession } from "../dist/main/tunnel.js";

const good = {
  code: "ABCD1234",
  hostname: "abcd1234.play.opendungeonmaster.com",
  tunnelToken: "tok",
  secret: "shh",
};

test("a complete broker reply on the official domain is accepted", () => {
  const session = parseBrokerSession(good, true);
  assert.equal(session.hostname, "abcd1234.play.opendungeonmaster.com");
  assert.equal(session.url, "https://abcd1234.play.opendungeonmaster.com");
});

test("the url is derived from the hostname, never trusted from the reply", () => {
  const session = parseBrokerSession({ ...good, url: "https://evil.example" }, true);
  assert.equal(session.url, "https://abcd1234.play.opendungeonmaster.com");
});

test("a hostname outside the official domain is rejected for the default broker", () => {
  const off = { ...good, hostname: "abcd1234.play.opendungeonmaster.com.evil.example" };
  assert.equal(parseBrokerSession(off, true), null);
  assert.equal(parseBrokerSession({ ...good, hostname: "evil.example" }, true), null);
});

test("a custom broker may use its own domain", () => {
  const custom = { ...good, hostname: "abcd.play.my-odm.example" };
  assert.equal(parseBrokerSession(custom, false).hostname, "abcd.play.my-odm.example");
});

test("garbage hostnames are rejected even for custom brokers", () => {
  for (const hostname of [
    "not a host",
    "https://x.play.opendungeonmaster.com",
    "x.play.opendungeonmaster.com/path",
    "user@x.play.opendungeonmaster.com",
    "",
  ]) {
    assert.equal(parseBrokerSession({ ...good, hostname }, false), null, hostname);
  }
});

test("uppercase hostnames are normalized before the suffix check", () => {
  const upper = { ...good, hostname: "ABCD1234.PLAY.OPENDUNGEONMASTER.COM" };
  assert.equal(parseBrokerSession(upper, true).hostname, "abcd1234.play.opendungeonmaster.com");
});

test("replies missing any credential field are rejected", () => {
  for (const key of ["code", "hostname", "tunnelToken", "secret"]) {
    assert.equal(parseBrokerSession({ ...good, [key]: "" }, true), null, key);
  }
  assert.equal(parseBrokerSession(null, true), null);
  assert.equal(parseBrokerSession("nope", true), null);
});
