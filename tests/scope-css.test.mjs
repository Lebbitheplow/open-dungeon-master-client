import assert from "node:assert/strict";
import test from "node:test";
import { scopeCss, scopePrelude, splitRules } from "../scripts/scope-css.mjs";

test("splitRules separates statements and braced rules and ignores braces in strings", () => {
  const rules = splitRules(`@layer a,b;.x{color:red}.y{background:url("a{b}c")}@media (min-width:1px){.z{top:0}}`);
  assert.deepEqual(rules, [
    { statement: "@layer a,b;" },
    { prelude: ".x", body: "color:red" },
    { prelude: ".y", body: 'background:url("a{b}c")' },
    { prelude: "@media (min-width:1px)", body: ".z{top:0}" },
  ]);
});

test("scopePrelude turns the document selectors into the scope and leaves the rest", () => {
  assert.equal(scopePrelude(":root,:host"), "&,:host");
  assert.equal(scopePrelude("body::before"), "&::before");
  assert.equal(scopePrelude("html"), "&");
  assert.equal(scopePrelude(".body-copy>body"), ".body-copy>&");
  assert.equal(scopePrelude("*,:before,:after,::backdrop"), "*,:before,:after,::backdrop");
  assert.equal(scopePrelude(".tbody,tbody"), ".tbody,tbody");
});

test("scopePrelude keeps the document's theme and effects attributes on <html>", () => {
  // The server writes data-theme and data-effects on <html>, in the apps too.
  assert.equal(scopePrelude('html[data-theme="light"] .plate-row'), 'html[data-theme="light"] & .plate-row');
  assert.equal(scopePrelude('[data-theme="light"] .seg-pill'), 'html[data-theme="light"] & .seg-pill');
  assert.equal(scopePrelude('[data-effects="low"] .ambient-dust::before'), 'html[data-effects="low"] & .ambient-dust::before');
  assert.equal(scopePrelude("html[data-theme=light]"), "html[data-theme=light] &");
  assert.equal(scopePrelude(':root[data-theme="light"]'), 'html[data-theme="light"] &');
  assert.equal(scopePrelude('html[data-theme="light"] body'), 'html[data-theme="light"] &');
  assert.equal(scopePrelude('html[data-theme="light"] body .glass'), 'html[data-theme="light"] & .glass');
  assert.equal(scopePrelude('.a,[data-effects="low"] .b'), '.a,html[data-effects="low"] & .b');
  // An attribute that lives on an ordinary element is left to nest as usual.
  assert.equal(scopePrelude('[data-state="open"] .x'), '[data-state="open"] .x');
});

test("scopeCss nests style rules, keeps keyframes and properties on top, recurses into layers", () => {
  const css = [
    "@layer theme,base;",
    "@layer theme{:root,:host{--c:red}@keyframes spin{to{transform:rotate(1turn)}}}",
    "@layer base{*,:after{margin:0}body{color:var(--c)}}",
    "@media (min-width:640px){.sm\\:flex{display:flex}}",
    "@property --tw-x{syntax:'*';inherits:false}",
    ".panel{border:1px solid}",
  ].join("");
  const out = scopeCss(css, ".game-root");
  assert.equal(
    out,
    [
      "@layer theme,base;",
      "@keyframes spin{to{transform:rotate(1turn)}}",
      "@property --tw-x{syntax:'*';inherits:false}",
      ".game-root{",
      "@layer theme{&,:host{--c:red}}",
      "@layer base{*,:after{margin:0}&{color:var(--c)}}",
      "@media (min-width:640px){.sm\\:flex{display:flex}}",
      ".panel{border:1px solid}",
      "}",
    ].join(""),
  );
});
