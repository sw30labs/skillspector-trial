#!/usr/bin/env node
// Skillspector build — inlines src/* into a single index.html
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(root, p), "utf8");

// Strip module syntax from engine so it can live in a plain <script>.
// Engine attaches itself to globalThis.SkillScanner; export lines are dev-only.
function stripExports(js) {
  return js
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, "")
    .replace(/^\s*export\s+default\s+/gm, "")
    .replace(/^\s*export\s+(const|let|var|function|async\s+function|class)\s+/gm, "$1 ");
}

const template = read("src/template.html");
const parts = {
  "/*__CSS__*/": read("src/style.css"),
  "/*__ENGINE__*/": stripExports(read("src/engine.js")),
  "/*__UI__*/": read("src/ui.js"),
};

let out = template;
for (const [marker, content] of Object.entries(parts)) {
  if (!out.includes(marker)) {
    console.error(`build: marker ${marker} missing from template.html`);
    process.exit(1);
  }
  out = out.replace(marker, () => content);
}
for (const marker of Object.keys(parts)) {
  if (out.includes(marker)) {
    console.error(`build: marker ${marker} still present after substitution`);
    process.exit(1);
  }
}

writeFileSync(resolve(root, "index.html"), out);
console.log(`build: index.html written (${(out.length / 1024).toFixed(1)} KB)`);
