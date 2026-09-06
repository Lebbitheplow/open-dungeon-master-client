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
