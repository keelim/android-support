#!/usr/bin/env node
// W1-android-01 — Action contract drift checker.
//
// Compares three contract surfaces that must stay aligned:
//   1. action.yml `inputs:` (declared inputs)
//   2. src/*.ts `getInput('x')` / `getBooleanInput('x')` calls (consumed inputs)
//   3. README.md input table (documented inputs)
//
// Fails (exit 1) ONLY on the dangerous case: an input consumed via getInput()
// that is NOT declared in action.yml (runtime breakage). Declared-but-unused and
// undocumented inputs are reported as informational and do not fail the gate.
//
// Usage: node scripts/check-contract-drift.mjs
// Pure static check; adds no runtime code, runs before the ncc build.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @returns {string[]} top-level input keys declared in action.yml */
function parseActionInputs() {
  const text = readFileSync(join(ROOT, 'action.yml'), 'utf8');
  const block = text.match(/^inputs:\s*$([\s\S]*?)^(?:outputs|runs|branding):/m);
  const body = block ? block[1] : '';
  return [...body.matchAll(/^ {2}([A-Za-z][A-Za-z0-9_]*):/gm)].map((m) => m[1]);
}

/** @returns {Set<string>} input names consumed via getInput() / getBooleanInput() in src/ */
function parseConsumedInputs() {
  const srcDir = join(ROOT, 'src');
  const names = new Set();
  for (const ent of readdirSync(srcDir, { withFileTypes: true })) {
    if (!ent.isFile() || !/\.ts$/.test(ent.name)) continue;
    const text = readFileSync(join(srcDir, ent.name), 'utf8');
    for (const m of text.matchAll(/get(?:Boolean)?Input\(\s*['"]([^'"]+)['"]/g)) names.add(m[1]);
  }
  return names;
}

/** @param {string[]} actionInputs @returns {Set<string>} documented input names */
function parseReadmeInputs(actionInputs) {
  const text = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const documented = new Set();
  for (const m of text.matchAll(/^\|\s*`?([A-Za-z][A-Za-z0-9_]*)`?\s*\|/gm)) {
    if (actionInputs.includes(m[1])) documented.add(m[1]);
  }
  return documented;
}

function main() {
  const actionInputs = parseActionInputs();
  const consumed = parseConsumedInputs();
  const documented = parseReadmeInputs(actionInputs);
  const actionSet = new Set(actionInputs);

  const undeclaredConsumed = [...consumed].filter((n) => !actionSet.has(n)).sort();
  const unusedDeclared = actionInputs.filter((n) => !consumed.has(n)).sort();
  const undocumented = actionInputs.filter((n) => !documented.has(n)).sort();

  console.log(`[contract-drift] action.yml inputs=${actionInputs.length} consumed=${consumed.size} documented=${documented.size}`);
  if (unusedDeclared.length) console.log(`[contract-drift] declared but not consumed (info): ${unusedDeclared.join(', ')}`);
  if (undocumented.length) console.log(`[contract-drift] not in README table (info): ${undocumented.join(', ')}`);

  if (undeclaredConsumed.length > 0) {
    console.error(`[contract-drift] FAIL: getInput() consumes inputs not declared in action.yml: ${undeclaredConsumed.join(', ')}`);
    process.exit(1);
  }
  console.log('[contract-drift] OK (every consumed input is declared in action.yml)');
}

main();
