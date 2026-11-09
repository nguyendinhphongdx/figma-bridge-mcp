// VM sandbox for figma_write code.
//
// node:vm is NOT a security boundary: any object or function that originates in
// the host realm lets sandboxed code climb to the host `Function` constructor
// (`x.constructor.constructor("return process")()`). So nothing host-realm is
// ever handed to user code:
//   - the context gets its own Object/Array/Promise/JSON/... (we pass none in)
//   - `figma` and `console` are built INSIDE the context from a bootstrap script
//   - the only host function is `__invoke`, captured in a closure and then
//     deleted from the global; it takes and returns plain strings, and never
//     throws or rejects, so no host Error or Promise reaches user code
// This hardens the sandbox against the known constructor escape but it is still
// vm, not a process boundary. For untrusted code use isolated-vm or a child process.
import { createRequire } from "node:module";

import { buildFigmaProxy } from "./figma-proxy.js";

const vm = createRequire(import.meta.url)("vm");

const TIMEOUT_MS = 30_000;

// Runs inside the context. `__invoke(kind, name, jsonArgs)` -> Promise<string>.
const BOOTSTRAP = `
(function (invoke, log, names) {
  var fmt = function (args) {
    return args.map(function (x) {
      if (typeof x !== "object" || x === null) return String(x);
      try { return JSON.stringify(x, null, 2); } catch (e) { return String(x); }
    }).join(" ");
  };
  var con = {};
  ["log", "error", "warn", "info"].forEach(function (lvl) {
    con[lvl] = function () { log(lvl, fmt(Array.prototype.slice.call(arguments))); };
  });
  var fig = {};
  names.forEach(function (name) {
    fig[name] = async function () {
      var raw = await invoke(name, JSON.stringify(Array.prototype.slice.call(arguments)));
      var r = JSON.parse(raw);
      if (!r.ok) throw new Error(r.error);
      var data = r.data;
      if (r.page !== undefined && Array.isArray(data)) {
        Object.defineProperty(data, "page", { value: r.page, enumerable: false });
      }
      return data;
    };
  });
  Object.defineProperty(globalThis, "figma",   { value: fig, enumerable: true });
  Object.defineProperty(globalThis, "console", { value: con, enumerable: true });
})
`;

/**
 * @returns {{ success: boolean, result?: unknown, error?: string, logs: string[] }}
 */
export async function executeCode(code, bridge, sessionId) {
  // Wrap bridge to pin sessionId for all operations in this execution
  var wrappedBridge = sessionId ? {
    sendOperation: function(op, params) { return bridge.sendOperation(op, params, sessionId); }
  } : bridge;

  const logs = [];
  const proxy = buildFigmaProxy(wrappedBridge);
  const names = Object.keys(proxy);

  // Host side of the single bridge: strings in, strings out, never throws.
  const invoke = async (name, jsonArgs) => {
    try {
      if (!Object.prototype.hasOwnProperty.call(proxy, name)) throw new Error("Unknown figma method: " + name);
      const args = JSON.parse(jsonArgs);
      const data = await proxy[name](...args);
      const out = { ok: true, data: data === undefined ? null : data };
      if (Array.isArray(data) && data.page !== undefined) out.page = data.page;
      return JSON.stringify(out);
    } catch (e) {
      return JSON.stringify({ ok: false, error: String((e && e.message) || e) });
    }
  };
  const log = (level, text) => {
    logs.push((level === "log" ? "" : "[" + level + "] ") + String(text));
  };

  const ctx = vm.createContext(Object.create(null));
  vm.runInContext(BOOTSTRAP, ctx, { filename: "figma-bootstrap.js" })(invoke, log, names);

  try {
    const result = await vm.runInContext(`(async()=>{ ${code} })()`, ctx, {
      timeout:  TIMEOUT_MS,
      filename: "figma-code.js",
    });
    return { success: true, result: result ?? null, logs };
  } catch (err) {
    let msg = err && err.message ? err.message : String(err);
    // Bug 5 fix: ReferenceError in sandbox means the variable was defined in a previous
    // figma_write call. Each call runs in an isolated VM context — variables don't persist.
    if (err && err.name === "ReferenceError") {
      msg += "\nNote: Each figma_write call runs in an isolated sandbox — variables from previous calls are not available. Re-query node IDs with figma.get_page_nodes() or figma.query() at the start of each call.";
    }
    return { success: false, error: msg, logs };
  }
}
