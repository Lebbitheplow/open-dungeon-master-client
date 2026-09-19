// Confines a whole stylesheet to one element's subtree, for the game
// screens' Tailwind build: the sheet is loaded into the shell's page,
// whose own screens must keep their look. Every style rule is nested
// under the scope selector (CSS nesting makes it a descendant rule), the
// document-level selectors (:root, html, body) become the scope element
// itself, and the rules that cannot live inside a style rule (@keyframes,
// @property, @font-face, @import, @charset, layer statements) stay at the
// top level. Pure text work on the minified output, no CSS parser.

const TOP_LEVEL = /^@(keyframes|-webkit-keyframes|property|font-face|import|charset)\b/;
const GROUP = /^@(layer|media|supports|container)\b/;

// Splits a block body into its top-level rules: {prelude, body} for a
// braced rule, {statement} for a semicolon-terminated one. Braces inside
// strings and url() are skipped.
export function splitRules(css) {
  const rules = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    while (i < n && /\s/.test(css[i])) i++;
    if (i >= n) break;
    const start = i;
    let depth = 0;
    let quote = "";
    let preludeEnd = -1;
    for (; i < n; i++) {
      const ch = css[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === "{") {
        if (depth === 0) preludeEnd = i;
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      } else if (ch === ";" && depth === 0) {
        i++;
        break;
      }
    }
    const text = css.slice(start, i).trim();
    if (!text) continue;
    if (preludeEnd < 0) {
      rules.push({ statement: text });
    } else {
      const prelude = css.slice(start, preludeEnd).trim();
      const body = css.slice(preludeEnd + 1, i - 1);
      rules.push({ prelude, body });
    }
  }
  return rules;
}

// :root, html and body point at the scope element; everything else nests
// beneath it. Written for minified preludes (no comments).
// Attributes the server writes on <html> and its stylesheet keys on: the day
// theme and the low effects setting. They stay on <html> in the apps too, so a
// selector that reads them has to keep looking there. Rewriting
// `html[data-theme="light"] .x` to `&[data-theme="light"] .x` asked the game
// root for an attribute it never carries, and a bare `[data-effects="low"] .x`
// nested under the root asked a descendant for it: between them the whole day
// theme and every low effects rule were dead inside the apps.
const DOCUMENT_ATTRIBUTE = /^(?:html|:root)?((?:\[data-(?:theme|effects)[^\]]*\])+)(?=$|[\s>+~:.#[])/;

export function scopePrelude(prelude) {
  return prelude
    .split(",")
    .map((part) => {
      let selector = part.trim();
      const documentLevel = DOCUMENT_ATTRIBUTE.exec(selector);
      if (documentLevel) {
        // "html[data-theme=light] .x" and "[data-theme=light] .x" both become
        // "html[data-theme=light] & .x": the attribute on <html>, the rest
        // inside the scope. Alone, the rule lands on the scope element itself.
        const rest = selector.slice(documentLevel[0].length).trim();
        const inner = rest.replace(/(^|[\s>+~])(html|body)(?=$|[\s>+~:.#[])/g, "$1&").replace(/:root\b/g, "&");
        // "html[...] body .x": the body already IS the scope element.
        if (inner.startsWith("&")) return `html${documentLevel[1]} ${inner}`;
        return `html${documentLevel[1]} &${inner ? ` ${inner}` : ""}`;
      }
      selector = selector.replace(/:root\b/g, "&");
      selector = selector.replace(/(^|[\s>+~])(html|body)(?=$|[\s>+~:.#[])/g, "$1&");
      return selector;
    })
    .join(",");
}

function walk(rules, top, out) {
  for (const rule of rules) {
    if (rule.statement) {
      // "@layer a, b;" and @import live at the top level.
      top.push(rule.statement);
      continue;
    }
    if (TOP_LEVEL.test(rule.prelude)) {
      top.push(`${rule.prelude}{${rule.body}}`);
      continue;
    }
    if (GROUP.test(rule.prelude)) {
      const inner = [];
      walk(splitRules(rule.body), top, inner);
      if (inner.length) out.push(`${rule.prelude}{${inner.join("")}}`);
      continue;
    }
    if (rule.prelude.startsWith("@")) {
      // Any other at-rule (@starting-style, @scope): keep as is, nested.
      out.push(`${rule.prelude}{${rule.body}}`);
      continue;
    }
    out.push(`${scopePrelude(rule.prelude)}{${rule.body}}`);
  }
}

export function scopeCss(css, scope) {
  const top = [];
  const nested = [];
  walk(splitRules(css), top, nested);
  return `${top.join("")}${scope}{${nested.join("")}}`;
}
