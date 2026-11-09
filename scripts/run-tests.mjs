#!/usr/bin/env node
// Runs every scripts/test-*.mjs in its own process, so a failing or hanging
// test cannot take the others down. Exits non-zero if any fails.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => /^test-.*\.mjs$/.test(f)).sort();
const failed = [];
for (const f of files) {
  const r = spawnSync(process.execPath, [join(dir, f)], { encoding: "utf8", timeout: 90_000 });
  const ok = r.status === 0;
  console.log((ok ? "✓ " : "✗ ") + f + (ok ? "" : r.error ? `  (${r.error.code})` : `  (exit ${r.status})`));
  if (!ok) { failed.push(f); process.stdout.write((r.stdout || "").split("\n").slice(-15).join("\n") + (r.stderr || "") + "\n"); }
}
console.log(`\n${files.length - failed.length}/${files.length} passed`);
process.exit(failed.length ? 1 : 0);
