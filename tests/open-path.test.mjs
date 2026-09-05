import assert from "node:assert/strict";
import { test } from "node:test";
import { landingPath, safeInnerPath } from "../dist/shared/open-path.js";

test("a plain same-origin path passes through", () => {
  assert.equal(safeInnerPath("/campaigns/abc-123"), "/campaigns/abc-123");
  assert.equal(safeInnerPath("/?new=1"), "/?new=1");
  assert.equal(safeInnerPath("/characters"), "/characters");
});

test("anything that could leave the origin is dropped", () => {
  assert.equal(safeInnerPath("//evil.example/x"), "");
  assert.equal(safeInnerPath("https://evil.example"), "");
  assert.equal(safeInnerPath("campaigns/abc"), "");
  assert.equal(safeInnerPath("/a\\b"), "");
  assert.equal(safeInnerPath("/" + "a".repeat(300)), "");
  assert.equal(safeInnerPath(42), "");
});

test("a join code always wins, and nothing falls back to the root", () => {
  assert.equal(landingPath("ABCD2345", "/campaigns/x"), "/join/ABCD2345");
  assert.equal(landingPath("", "/campaigns/x"), "/campaigns/x");
  assert.equal(landingPath("", "javascript:alert(1)"), "/");
  assert.equal(landingPath(""), "/");
});
