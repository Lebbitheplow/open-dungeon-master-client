import assert from "node:assert/strict";
import test from "node:test";
import { GameRouter, isAbsoluteUrl, matchRoute } from "../dist/shared/game-router.js";

test("matchRoute reads params one segment at a time", () => {
  assert.deepEqual(matchRoute("/", "/"), {});
  assert.deepEqual(matchRoute("/campaigns/:campaignId", "/campaigns/abc-1"), { campaignId: "abc-1" });
  assert.deepEqual(matchRoute("/campaigns/:campaignId/character", "/campaigns/x/character"), { campaignId: "x" });
  assert.equal(matchRoute("/campaigns/:campaignId", "/campaigns/x/character"), null);
  assert.equal(matchRoute("/characters", "/characters/new"), null);
  assert.deepEqual(matchRoute("/join/:code", "/join/ABCD%202"), { code: "ABCD 2" });
});

test("the router keeps a stack, splits queries, and notifies on every change", () => {
  const router = new GameRouter("/?new=1");
  const seen = [];
  router.subscribe(() => seen.push(router.location.pathname + router.location.search));
  assert.deepEqual(router.location, { pathname: "/", search: "?new=1" });
  router.push("/campaigns/c1");
  router.replace("/campaigns/c1?tab=party");
  assert.equal(router.depth, 2);
  assert.equal(router.back(), true);
  assert.equal(router.back(), false);
  assert.deepEqual(seen, ["/campaigns/c1", "/campaigns/c1?tab=party", "/?new=1"]);
});

test("a full URL leaves the native screens instead of joining the stack", () => {
  const router = new GameRouter("/");
  const left = [];
  router.onLeave = (url) => left.push(url);
  router.push("https://discord.com/oauth");
  router.replace("mailto:someone@example.com");
  assert.deepEqual(left, ["https://discord.com/oauth", "mailto:someone@example.com"]);
  assert.equal(router.depth, 1);
  assert.equal(isAbsoluteUrl("/api/x"), false);
  assert.equal(isAbsoluteUrl("//cdn.example/x"), false);
});

test("refresh keeps the address but yields a new location object", () => {
  const router = new GameRouter("/settings?linked=1");
  const before = router.location;
  let fired = 0;
  router.subscribe(() => fired++);
  router.refresh();
  assert.notEqual(router.location, before);
  assert.deepEqual(router.location, before);
  assert.equal(fired, 1);
});
