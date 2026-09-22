import assert from "node:assert/strict";
import test from "node:test";
import { hostRelativePath } from "../dist/shared/host-fetch.js";

// A host page's fetch reaches the host whether it passes a root-relative
// string or a Request (whose url is absolute, resolved against the app's
// own page); an address elsewhere is left alone.
test("root-relative strings and same-origin absolute URLs are host paths", () => {
  const desktop = "file:///opt/odm/dist/renderer/index.html";
  const android = "https://localhost/index.html";
  assert.equal(hostRelativePath("/api/campaigns?x=1", desktop), "/api/campaigns?x=1");
  assert.equal(hostRelativePath("//cdn.example/x.png", desktop), null);
  assert.equal(hostRelativePath("file:///api/campaigns", desktop), "/api/campaigns");
  assert.equal(hostRelativePath("https://localhost/api/campaigns?a=b#frag", android), "/api/campaigns?a=b");
  assert.equal(hostRelativePath("https://localhost/api/campaigns", desktop), null, "another origin is not the host");
  assert.equal(hostRelativePath("http://10.0.0.5:3000/api/campaigns", android), null);
  assert.equal(hostRelativePath("data:text/plain,hi", android), null);
  assert.equal(hostRelativePath("not a url", "not a base"), null);
});

test("a Request made by the page resolves to a host path", () => {
  const request = new globalThis.Request("https://localhost/api/campaigns/c1/messages", { method: "POST", body: "{}" });
  assert.equal(hostRelativePath(request.url, "https://localhost/index.html"), "/api/campaigns/c1/messages");
  const elsewhere = new globalThis.Request("https://example.com/api/x");
  assert.equal(hostRelativePath(elsewhere.url, "https://localhost/index.html"), null);
});
