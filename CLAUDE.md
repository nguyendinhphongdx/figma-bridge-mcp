# figma-bridge-mcp

MCP server + Figma plugin. An AI client calls MCP tools (`figma_write`, `figma_read`, ...); the server
queues operations on a local HTTP bridge; the Figma plugin long-polls the bridge, runs them against the
open document and posts results back. npm package: `@hanoilab/figma-bridge-mcp`. Fork of
TranHoaiHung/figma-ui-mcp (MIT: keep the original copyright line in LICENSE).

## Layout
- `server/` — Node ESM, the part that ships to npm. `index.js` (MCP entry, stdio), `bridge-server.js`
  (HTTP bridge, sessions, long-poll), `code-executor.js` (vm sandbox for `figma_write`),
  `figma-proxy.js` (the `figma.*` API seen by user code), `http-fetch.js` (guarded fetch),
  `allowed-ops.js` (operation allowlist), `docs/` (served by `figma_docs`).
- `src/plugin/*.js` — plugin source. **Not modules**: concatenated into one shared scope.
- `plugin/code.js` — GENERATED from `src/plugin`. Never edit by hand.
- `scripts/` — `build-plugin.js`, `run-tests.mjs`, `test-*.mjs`, `lib/` (shared loader, split guard).

## Commands
- `npm run build:plugin` — regenerate `plugin/code.js` (a hook does this when you edit `src/plugin/`).
- `npm test` — runs every `scripts/test-*.mjs` in its own process. No live Figma needed (mock bridge).
- Tests bind fixed local ports (38490+, 47311). If a port is "in use" on your machine, set
  `FIGMA_MCP_PORT` to a free one for that test.

## Rules that are easy to get wrong
- Concatenation order lives only in `scripts/lib/plugin-files.mjs`. `handlers-core.js` must come before any
  file that adds to `handlers`. When adding or splitting a file, edit that list (build and tests both read it).
  After a split run `node scripts/lib/verify-split.mjs snapshot` before and `check` after.
- Adding a plugin operation: handler in `src/plugin/`, name in `server/allowed-ops.js` (`/exec` and the
  MCP path both enforce it), docs in `server/docs/`, a test in `scripts/`.
- Security invariants (see `scripts/test-security.mjs`, do not weaken):
  - no host-realm object may reach `figma_write` code (`vm` is not a boundary; the sandbox passes strings only);
  - the bridge rejects requests with a web `Origin` or non-loopback `Host`;
  - `httpFetch` blocks private/loopback targets, including after redirects;
  - a pinned `sessionId` that is not connected must error, never fall back to another file.
- Package name is scoped, so `npm publish` needs `--access public`. Publishing is done only by CI
  (`.github/workflows/release.yml`, on push to `main` when `package.json` version differs from npm).
- Releasing: bump `version` in `package.json`, rename the CHANGELOG heading to `## [x.y.z] - date`
  (the workflow extracts release notes by that exact heading), push to `main`. The plugin zip is built by CI
  and attached to the GitHub Release; do not commit a zip.
- Branding: do not put "Figma" at the start of a product name; "Bridge MCP for Figma" is the display name.
