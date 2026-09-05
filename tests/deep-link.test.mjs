import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_SHAPE,
  joinLinkFromArgv,
  normalizeOrigin,
  originCandidates,
  parseAnyLink,
  parseJoinLink,
  parseServerAddress,
} from "../dist/shared/deep-link.js";

test("normalizeOrigin keeps clean http(s) origins", () => {
  assert.equal(normalizeOrigin("https://play.example.com/lobby?x=1"), "https://play.example.com");
  assert.equal(normalizeOrigin("http://192.168.1.50:3005"), "http://192.168.1.50:3005");
});

test("normalizeOrigin rejects junk", () => {
  assert.equal(normalizeOrigin("ftp://example.com"), null);
  assert.equal(normalizeOrigin("javascript:alert(1)"), null);
  assert.equal(normalizeOrigin("https://good.com@evil.com"), null);
  assert.equal(normalizeOrigin(""), null);
  assert.equal(normalizeOrigin("x".repeat(301)), null);
});

test("originCandidates tries https then http for bare hosts", () => {
  assert.deepEqual(originCandidates("play.example.com"), [
    "https://play.example.com",
    "http://play.example.com",
  ]);
  assert.deepEqual(originCandidates("https://play.example.com"), ["https://play.example.com"]);
  assert.deepEqual(originCandidates("ftp://x"), []);
});

test("parseJoinLink accepts the /j Worker shape", () => {
  const link = parseJoinLink("odm://join?s=https%3A%2F%2Fplay.example.com&c=abcd2345");
  assert.deepEqual(link, { origin: "https://play.example.com", code: "ABCD2345" });
});

test("parseJoinLink rejects bad codes, schemes and actions", () => {
  assert.equal(parseJoinLink("odm://join?s=https://x.com&c=ab"), null);
  assert.equal(parseJoinLink("odm://join?s=https://x.com&c=ABCD0IL1"), null);
  assert.equal(parseJoinLink("odm://steal?s=https://x.com&c=ABCD2345"), null);
  assert.equal(parseJoinLink("https://join?s=https://x.com&c=ABCD2345"), null);
  assert.equal(parseJoinLink("odm://join?s=ftp://x.com&c=ABCD2345"), null);
});

test("parseAnyLink accepts both the odm and https invite shapes", () => {
  const expected = { origin: "https://play.example.com", code: "ABCD2345" };
  assert.deepEqual(
    parseAnyLink("odm://join?s=https%3A%2F%2Fplay.example.com&c=ABCD2345"),
    expected,
  );
  assert.deepEqual(
    parseAnyLink("https://opendungeonmaster.com/j?s=https%3A%2F%2Fplay.example.com&c=abcd2345"),
    expected,
  );
  assert.deepEqual(
    parseAnyLink("https://opendungeonmaster.com/j/abcd2345?s=https%3A%2F%2Fplay.example.com"),
    expected,
  );
  assert.deepEqual(
    parseAnyLink("  https://opendungeonmaster.com/j?s=https%3A%2F%2Fplay.example.com&c=ABCD2345 "),
    expected,
  );
});

test("parseAnyLink rejects lookalike hosts, plain http and bad codes", () => {
  assert.equal(parseAnyLink("https://evil.com/j?s=https%3A%2F%2Fx.com&c=ABCD2345"), null);
  assert.equal(parseAnyLink("http://opendungeonmaster.com/j?s=https%3A%2F%2Fx.com&c=ABCD2345"), null);
  assert.equal(parseAnyLink("https://opendungeonmaster.com/other?s=https%3A%2F%2Fx.com&c=ABCD2345"), null);
  assert.equal(parseAnyLink("https://opendungeonmaster.com/j?s=https%3A%2F%2Fx.com&c=ABCD01"), null);
  assert.equal(parseAnyLink("https://opendungeonmaster.com/j?c=ABCD2345"), null);
  assert.equal(parseAnyLink("play.example.com"), null);
});

test("joinLinkFromArgv finds the deep link among flags", () => {
  const argv = ["electron", "--flag", "odm://join?s=https://x.com&c=ABCD2345"];
  assert.deepEqual(joinLinkFromArgv(argv), { origin: "https://x.com", code: "ABCD2345" });
  assert.equal(joinLinkFromArgv(["electron", "."]), null);
});

test("code shape matches the server invite alphabet", () => {
  assert.ok(CODE_SHAPE.test("ABCDEF"));
  assert.ok(!CODE_SHAPE.test("ABC"));
  assert.ok(!CODE_SHAPE.test("ABCDEFGHJKLMN"));
  assert.ok(!CODE_SHAPE.test("ABCO23"));
});

test("parseAnyLink accepts a server's own readable /join/CODE link", () => {
  assert.deepEqual(parseAnyLink("https://play.example.com/join/abcd2345"), {
    origin: "https://play.example.com",
    code: "ABCD2345",
  });
  assert.deepEqual(parseAnyLink("http://192.168.1.50:3005/join/ABCD2345/"), {
    origin: "http://192.168.1.50:3005",
    code: "ABCD2345",
  });
  assert.equal(parseAnyLink("https://play.example.com/join/ab"), null);
  assert.equal(parseAnyLink("https://play.example.com/join/ABCD2345/extra"), null);
  assert.equal(parseAnyLink("https://play.example.com/lobby"), null);
});

test("parseServerAddress takes a bare origin and nothing more", () => {
  assert.equal(parseServerAddress("http://192.168.1.50:3005"), "http://192.168.1.50:3005");
  assert.equal(parseServerAddress("https://play.example.com/"), "https://play.example.com");
  assert.equal(parseServerAddress("  https://play.example.com  "), "https://play.example.com");
  // A join link is an invite, not a server address; callers try invites first
  // and this must not swallow one that failed to parse as an invite.
  assert.equal(parseServerAddress("https://play.example.com/join/ABCD2345"), null);
  assert.equal(parseServerAddress("https://play.example.com/?x=1"), null);
  assert.equal(parseServerAddress("play.example.com"), null);
  assert.equal(parseServerAddress("ftp://play.example.com"), null);
  assert.equal(parseServerAddress("https://good.com@evil.com"), null);
});
