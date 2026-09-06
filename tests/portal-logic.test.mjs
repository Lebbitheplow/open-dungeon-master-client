import assert from "node:assert/strict";
import test from "node:test";
import { parseVersion, portalEligible } from "../dist/shared/portal-logic.js";

test("parseVersion reads the leading x.y.z and ignores tags", () => {
  assert.deepEqual(parseVersion("0.16.0"), [0, 16, 0]);
  assert.deepEqual(parseVersion("1.2.3-beta"), [1, 2, 3]);
  assert.equal(parseVersion(""), null);
  assert.equal(parseVersion("dev"), null);
});

test("a host at or above the bundled minor is eligible", () => {
  assert.deepEqual(portalEligible({ bundled: "0.16.0", remote: "0.16.0" }), { ok: true });
  assert.deepEqual(portalEligible({ bundled: "0.16.0", remote: "0.16.4" }), { ok: true });
  assert.deepEqual(portalEligible({ bundled: "0.16.2", remote: "0.17.0" }), { ok: true });
});

test("an older host, another major line, or an unknown version opens its own pages", () => {
  assert.equal(portalEligible({ bundled: "0.16.0", remote: "0.15.0" }).ok, false);
  assert.equal(portalEligible({ bundled: "1.0.0", remote: "0.16.0" }).ok, false);
  assert.equal(portalEligible({ bundled: "0.16.0", remote: "" }).ok, false);
});

test("a bundled server without the proxy never portals", () => {
  assert.equal(portalEligible({ bundled: "0.15.0", remote: "0.16.0" }).ok, false);
  assert.equal(portalEligible({ bundled: "", remote: "0.16.0" }).ok, false);
});
