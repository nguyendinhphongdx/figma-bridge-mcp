#!/usr/bin/env node
// Claude Code PostToolUse hook: plugin/code.js is generated from src/plugin/*.js,
// so after an edit under src/plugin/ rebuild it. Otherwise tests that load the
// bundle and the shipped plugin silently drift from the source.
// Reads the hook payload on stdin; never fails the tool call.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

let file = "";
try { file = JSON.parse(readFileSync(0, "utf8")).tool_input?.file_path || ""; } catch { /* no payload */ }

// Normalise Windows separators so one pattern covers both platforms.
const p = file.split("\\").join("/");

if (/\/src\/plugin\/[^/]+\.js$/.test(p) || /\/scripts\/lib\/plugin-files\.mjs$/.test(p)) {
  try {
    process.stdout.write(execFileSync(process.execPath, ["scripts/build-plugin.js"], { encoding: "utf8" }));
  } catch (e) {
    process.stderr.write("rebuild-plugin: build failed\n" + (e.stderr || e.message) + "\n");
  }
}
