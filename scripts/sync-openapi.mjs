#!/usr/bin/env node
// Brings openapi/api.openapi.json, the contract every test holds the CLI to,
// in step with the published BillionSend API document.
//
//   pnpm openapi:sync                       fetch https://billionsend.com/docs/api.openapi.json
//   pnpm openapi:sync -- --from <file|url>  take it from elsewhere (a local checkout, a staging site)
//   pnpm openapi:sync -- --check            change nothing; exit 1 when the snapshot differs
//
// After a sync, run the tests: what fails is what the CLI has to follow.
import { readFileSync, writeFileSync } from "node:fs";

export const PUBLISHED_URL = "https://billionsend.com/docs/api.openapi.json";
const SNAPSHOT = new URL("../openapi/api.openapi.json", import.meta.url);

const args = process.argv.slice(2).filter((a) => a !== "--");
const fromIndex = args.indexOf("--from");
const source = fromIndex >= 0 ? args[fromIndex + 1] : PUBLISHED_URL;
const check = args.includes("--check");
if (!source) {
  console.error("--from needs a file path or a URL");
  process.exit(1);
}

async function load(from) {
  if (/^https?:\/\//.test(from)) {
    const response = await fetch(from, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`${from} answered ${response.status}`);
    return await response.text();
  }
  return readFileSync(from, "utf8");
}

const operations = (text) => {
  const doc = JSON.parse(text);
  const out = new Set();
  for (const [path, ops] of Object.entries(doc.paths ?? {})) {
    for (const method of Object.keys(ops)) {
      if (method !== "parameters") out.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return out;
};

let next;
try {
  next = await load(source);
} catch (error) {
  if (check) {
    // The published document cannot be reached (offline, or not yet public): say so, but do not fail.
    console.log(`::warning::could not read ${source}: ${error.message}`);
    process.exit(0);
  }
  throw error;
}
const nextOps = operations(next);
const current = readFileSync(SNAPSHOT, "utf8");
if (current === next) {
  console.log(`openapi/api.openapi.json matches ${source} (${nextOps.size} operations)`);
  process.exit(0);
}
const currentOps = operations(current);
const added = [...nextOps].filter((op) => !currentOps.has(op));
const removed = [...currentOps].filter((op) => !nextOps.has(op));
console.log(`openapi/api.openapi.json differs from ${source}`);
for (const op of added) console.log(`  + ${op}`);
for (const op of removed) console.log(`  - ${op}`);
if (added.length === 0 && removed.length === 0)
  console.log("  (same operations; schemas or text changed)");
if (check) process.exit(1);
writeFileSync(SNAPSHOT, next);
console.log("Snapshot updated; run pnpm test.");
