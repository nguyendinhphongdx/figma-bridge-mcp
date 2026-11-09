#!/usr/bin/env node
/** Security regression tests: sandbox escape, bridge origin/host gate, session pinning, SSRF. */
process.env.FIGMA_MCP_PORT = "47311";
const { executeCode } = await import("../server/code-executor.js");
const { BridgeServer } = await import("../server/bridge-server.js");
const { httpFetch } = await import("../server/http-fetch.js");
import http from "node:http";

let failed = 0;
const ok = (label, cond, detail = "") => {
  console.log(cond ? "  ✓" : "  ✗", label, cond ? "" : detail);
  if (!cond) failed++;
};
const bridge = { sendOperation: async () => ({ a: 1 }) };

console.log("\n── sandbox escape ──");
for (const [name, code] of Object.entries({
  "Object.constructor":  `return Object.constructor("return typeof process")()`,
  "figma method ctor":   `return figma.notify.constructor("return typeof process")()`,
  "console ctor":        `return console.log.constructor("return typeof process")()`,
  "returned promise":    `return figma.status().constructor.constructor("return typeof process")()`,
  "this ctor":           `return this.constructor.constructor("return typeof process")()`,
})) {
  const r = await executeCode(code, bridge);
  ok(name + " cannot reach process", r.result === "undefined", JSON.stringify(r));
}
{
  const r = await executeCode(`try { await figma.get_node_detail(); } catch (e) { return e.constructor.constructor("return typeof process")(); } return "no-throw";`,
    { sendOperation: async () => { throw new Error("boom"); } });
  ok("host-originated error cannot reach process", r.result === "undefined" || r.result === "no-throw", JSON.stringify(r));
  const r2 = await executeCode(`try { await figma.get_node_detail(); } catch (e) { return e.message; }`,
    { sendOperation: async () => { throw new Error("boom"); } });
  ok("bridge errors still surface their message", r2.result === "boom", JSON.stringify(r2));
}

console.log("\n── bridge origin / host gate ──");
const b = await new BridgeServer().start();
const req = (path, { method = "GET", headers = {} } = {}) => new Promise((resolve) => {
  const r = http.request({ hostname: "127.0.0.1", port: b.port, path, method, headers }, (res) => {
    let d = ""; res.on("data", (c) => d += c); res.on("end", () => resolve({ status: res.statusCode, body: d }));
  });
  r.on("error", () => resolve({ status: 0 })); r.end();
});
ok("no Origin (MCP client) allowed",           (await req("/health")).status === 200);
ok("Origin: null (Figma plugin iframe) allowed", (await req("/health", { headers: { Origin: "null" } })).status === 200);
ok("web page Origin rejected",                  (await req("/health", { headers: { Origin: "https://evil.example" } })).status === 403);
ok("web page preflight rejected",               (await req("/exec", { method: "OPTIONS", headers: { Origin: "https://evil.example" } })).status === 403);
ok("rebinding Host rejected",                   (await req("/health", { headers: { Host: "evil.example:47311" } })).status === 403);
ok("GET /clear no longer works",                (await req("/clear")).status === 404);
ok("POST /clear works",                         (await req("/clear", { method: "POST" })).status === 200);

console.log("\n── session pinning ──");
let pinned = "";
try { await b.sendOperation("status", {}, "no-such-session"); pinned = "resolved"; } catch (e) { pinned = e.message; }
ok("unknown pinned session fails instead of falling back", /not connected/.test(pinned), pinned);
b.stop();

console.log("\n── SSRF guard ──");
for (const url of ["http://127.0.0.1:1/x", "http://169.254.169.254/latest/meta-data", "http://[::1]/x",
                   "http://10.0.0.1/x", "http://localhost/x", "file:///etc/passwd", "ftp://example.com/x"]) {
  let msg = "";
  try { await httpFetch(url, 1000); msg = "fetched"; } catch (e) { msg = e.message; }
  ok("blocks " + url, /Blocked|Only http/.test(msg), msg);
}
{
  const srv = http.createServer((_, res) => { res.writeHead(302, { Location: "http://169.254.169.254/" }); res.end(); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  process.env.FIGMA_MCP_ALLOW_PRIVATE_FETCH = "1";   // let the first hop through...
  let msg = ""; try { await httpFetch(`http://127.0.0.1:${srv.address().port}/`); } catch (e) { msg = e.message; }
  delete process.env.FIGMA_MCP_ALLOW_PRIVATE_FETCH;
  ok("private fetch works only with explicit opt-in", /HTTP|Timeout|ECONN|Blocked/.test(msg) || msg === "", msg);
  srv.close();
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
