// HTTP bridge — plugin polls this server for queued operations
// Supports long polling, multi-instance sessions, and connection resilience
import http from "node:http";
import { randomUUID } from "node:crypto";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ALL_OPS } from "./allowed-ops.js";
import { STATUS_PAGE } from "./status-page.js";

// From package.json so the / route cannot report a stale version.
const VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")
).version;

export const CONFIG = {
  PORT: parseInt(process.env.FIGMA_MCP_PORT || "38451", 10),
  PORT_RANGE: 10,
  // Loopback only. The bridge has no authentication and /exec drives the user's
  // Figma document, so binding every interface would let any host on the LAN —
  // and, with CORS "*" below, any web page the user has open — read, modify and
  // delete their design. Override only if you know what you are exposing.
  HOST: process.env.FIGMA_MCP_HOST || "127.0.0.1",
  OP_TIMEOUT_MS: 60_000,
  MAX_BODY_BYTES: 5_000_000,
  MAX_QUEUE: 50,
  HEALTH_TTL_MS: 120_000,    // 2 min — survives browser tab throttling (~1Hz background polls)
  // Short for Figma iframe compat (some envs limit fetch ~10s). Overridable so
  // tests need not wait the full hold for each parked poll.
  LONG_POLL_MS: parseInt(process.env.FIGMA_MCP_LONG_POLL_MS || "8000", 10),
  SESSION_EXPIRE_MS: 1_800_000, // 30 min — keep session around when user steps away briefly
};

// Operation-specific timeouts
const OP_TIMEOUTS = {
  screenshot: 90_000, scan_design: 90_000, export_image: 90_000,
  export_svg: 60_000, get_design: 60_000, batch: 90_000,
};

// Per-session state for multi-instance support
class Session {
  constructor(id, fileName) {
    this.id = id;
    this.fileName = fileName || "unknown";
    this.queue = [];
    this.pending = new Map();   // opId -> { resolve, reject, timer, startMs }
    this.lastPollAt = 0;
    this.longPoll = null;       // { res, timer }
    this.stats = { ops: 0, avgLatencyMs: 0 };
  }
  isConnected() {
    return this.lastPollAt > 0 && Date.now() - this.lastPollAt < CONFIG.HEALTH_TTL_MS;
  }
}

export class BridgeServer {
  #sessions = new Map();      // sessionId -> Session
  #opToSession = new Map();   // opId -> sessionId (global reverse lookup)
  #server = null;
  #server6 = null;
  #actualPort = CONFIG.PORT;
  #globalStats = { ops: 0, avgLatencyMs: 0, reconnects: 0 };

  static DEFAULT_SESSION = "_default";

  // ── Public getters (backward compat) ──────────────────────────────────────

  get port() { return this.#actualPort; }

  get lastPollAt() {
    var latest = 0;
    for (var s of this.#sessions.values()) if (s.lastPollAt > latest) latest = s.lastPollAt;
    return latest;
  }

  get queueLength() {
    var n = 0;
    for (var s of this.#sessions.values()) n += s.queue.length;
    return n;
  }

  get pendingCount() { return this.#opToSession.size; }

  get stats() {
    return Object.assign({}, this.#globalStats, { sessions: this.#sessions.size });
  }

  // ── Session management ────────────────────────────────────────────────────

  #getSession(id) {
    var sid = id || BridgeServer.DEFAULT_SESSION;
    var s = this.#sessions.get(sid);
    if (!s) {
      this.#cleanupSessions();   // expired sessions otherwise only go away on /health
      s = new Session(sid);
      this.#sessions.set(sid, s);
    }
    return s;
  }

  // Find best session: prefer given id, then session with active long-poll,
  // then most recently polled connected session, finally default
  #resolveSession(sessionId) {
    if (sessionId) {
      var s = this.#sessions.get(sessionId);
      if (s && s.isConnected()) return s;
      // A pinned session that is not connected must fail loudly. Falling through
      // to "any connected session" would silently write into a different Figma file.
      throw new Error("Session \"" + sessionId + "\" is not connected. Open the plugin in that file, or omit sessionId to use the active one.");
    }
    // Prefer session with active long-poll waiter (ready to receive work NOW)
    var bestLongPoll = null;
    var bestConnected = null;
    for (var s of this.#sessions.values()) {
      if (s.longPoll && s.isConnected()) {
        if (!bestLongPoll || s.lastPollAt > bestLongPoll.lastPollAt) bestLongPoll = s;
      }
      if (s.isConnected()) {
        if (!bestConnected || s.lastPollAt > bestConnected.lastPollAt) bestConnected = s;
      }
    }
    if (bestLongPoll) return bestLongPoll;
    if (bestConnected) return bestConnected;
    return this.#getSession(BridgeServer.DEFAULT_SESSION);
  }

  getSessions() {
    var list = [];
    for (var s of this.#sessions.values()) {
      list.push({
        id: s.id, fileName: s.fileName, connected: s.isConnected(),
        lastPollAgoMs: s.lastPollAt ? Date.now() - s.lastPollAt : null,
        queueLength: s.queue.length, ops: s.stats.ops,
      });
    }
    return list;
  }

  isPluginConnected(sessionId) {
    if (sessionId) {
      var s = this.#sessions.get(sessionId);
      return s ? s.isConnected() : false;
    }
    for (var s of this.#sessions.values()) if (s.isConnected()) return true;
    return false;
  }

  // Remove expired sessions periodically
  #cleanupSessions() {
    var now = Date.now();
    for (var [id, s] of this.#sessions) {
      if (!s.isConnected() && s.queue.length === 0 && s.pending.size === 0 && now - s.lastPollAt > CONFIG.SESSION_EXPIRE_MS) {
        this.#sessions.delete(id);
      }
    }
  }

  // ── Core operations ───────────────────────────────────────────────────────

  async sendOperation(operation, params, sessionId) {
    var session = this.#resolveSession(sessionId);
    if (session.queue.length >= CONFIG.MAX_QUEUE) {
      throw new Error("Queue full — is the Figma plugin running?");
    }

    var timeout = OP_TIMEOUTS[operation] || CONFIG.OP_TIMEOUT_MS;
    var opId = Date.now() + "-" + randomUUID();

    // CRITICAL: set pending BEFORE queue+flush, so respondPoll filter sees the opId
    var self = this;
    return new Promise(function(resolve, reject) {
      var timer = setTimeout(function() {
        session.pending.delete(opId);
        session.queue = session.queue.filter(function(r) { return r.id !== opId; });
        self.#opToSession.delete(opId);
        reject(new Error("Operation \"" + operation + "\" timed out after " + timeout + "ms"));
      }, timeout);
      session.pending.set(opId, { resolve: resolve, reject: reject, timer: timer, startMs: Date.now() });

      // Now push to queue and flush — pending is already set
      session.queue.push({ id: opId, operation: operation, params: params || {} });
      self.#opToSession.set(opId, session.id);
      self.#flushLongPoll(session);
    });
  }

  #flushLongPoll(session) {
    if (!session.longPoll) return;
    var w = session.longPoll;
    session.longPoll = null;
    clearTimeout(w.timer);
    this.#respondPoll(session, w.res);
  }

  #respondPoll(session, res) {
    session.lastPollAt = Date.now();
    var alive = session.queue.filter(function(r) { return session.pending.has(r.id); });
    session.queue.length = 0;
    if (alive.length) process.stderr.write("[bridge] poll → session=" + session.id + " delivering " + alive.length + " ops: " + alive.map(function(r) { return r.operation; }).join(",") + "\n");
    res.writeHead(200);
    res.end(JSON.stringify({ requests: alive, mode: "ready", sessionId: session.id }));
  }

  #settle(response) {
    var sessionId = this.#opToSession.get(response.id);
    if (!sessionId) {
      process.stderr.write("[bridge] settle ORPHAN response id=" + response.id + " (no matching session)\n");
      return;
    }
    this.#opToSession.delete(response.id);

    var session = this.#sessions.get(sessionId);
    if (!session) return;

    var p = session.pending.get(response.id);
    if (!p) return;
    clearTimeout(p.timer);
    session.pending.delete(response.id);

    // Track latency
    if (p.startMs) {
      var latency = Date.now() - p.startMs;
      session.stats.ops++;
      session.stats.avgLatencyMs = Math.round(session.stats.avgLatencyMs * 0.9 + latency * 0.1);
      this.#globalStats.ops++;
      this.#globalStats.avgLatencyMs = Math.round(this.#globalStats.avgLatencyMs * 0.9 + latency * 0.1);
    }
    response.success ? p.resolve(response.data) : p.reject(new Error(response.error || "Plugin error"));
  }

  clearQueue(sessionId) {
    var cleared = 0;
    var sessions = sessionId ? [this.#sessions.get(sessionId)].filter(Boolean) : Array.from(this.#sessions.values());
    for (var s of sessions) {
      cleared += s.queue.length + s.pending.size;
      for (var [id, p] of s.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("Queue cleared manually"));
        this.#opToSession.delete(id);
      }
      s.pending.clear();
      s.queue.length = 0;
    }
    return cleared;
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────

  #readJson(req) {
    return new Promise(function(resolve, reject) {
      var chunks = [], size = 0;
      req.on("data", function(chunk) {
        size += chunk.length;
        if (size > CONFIG.MAX_BODY_BYTES) { req.destroy(); return reject(new Error("Body too large")); }
        chunks.push(chunk);   // decode once at the end: a multibyte char can span chunks
      });
      req.on("end", function() { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch(e) { reject(new Error("Invalid JSON")); } });
      req.on("error", reject);
    });
  }

  #headers(res) {
    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Session-Id");
    res.setHeader("Content-Type",                 "application/json");
    res.setHeader("X-Content-Type-Options",       "nosniff");
  }

  // The bridge has no auth, so the network layer is the only gate. Browsers
  // always attach Origin to cross-site requests: a web page the user has open
  // arrives with a real origin, while the Figma plugin iframe sends "null" and
  // the MCP client (node http) sends none. Rejecting real origins stops a
  // malicious page from driving /exec, and checking Host stops DNS rebinding.
  #isAllowedRequest(req) {
    var origin = req.headers.origin;
    if (origin !== undefined && origin !== "null") {
      // Allow only the status page calling back into its own origin: a loopback
      // origin on the same port. Any other site (or rebinding host) stays blocked.
      var m = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/i.exec(origin);
      var hostPort = ((req.headers.host || "").match(/:(\d+)$/) || [])[1];
      if (!m || !hostPort || m[2] !== hostPort) return false;
    }
    var host = (req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
      // Only enforced while bound to loopback; an explicit FIGMA_MCP_HOST override opts out.
      if (CONFIG.HOST === "127.0.0.1" || CONFIG.HOST === "localhost") return false;
    }
    return true;
  }

  #route(req, res) {
    this.#headers(res);
    if (!this.#isAllowedRequest(req)) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: "Forbidden origin" }));
      return;
    }
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    var url = new URL(req.url, "http://localhost:" + CONFIG.PORT);
    var path = url.pathname;
    // Session ID from query param or header (backward compat: absent = default)
    var sessionId = url.searchParams.get("sessionId") || req.headers["x-session-id"] || null;
    var fileName = url.searchParams.get("fileName") || null;

    // Temporary status page for humans: /ui, and / when the client asks for HTML.
    var wantsHtml = (req.headers.accept || "").indexOf("text/html") !== -1;
    if (req.method === "GET" && (path === "/ui" || (path === "/" && wantsHtml))) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'");
      res.setHeader("Cache-Control", "no-store");
      res.writeHead(200);
      res.end(STATUS_PAGE);
      return;
    }

    // Root
    if (path === "/" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify({
        server: "figma-bridge-mcp", version: VERSION, port: this.#actualPort,
        pluginConnected: this.isPluginConnected(),
        sessions: this.getSessions(),
        queueLength: this.queueLength,
        endpoints: ["/ui", "/health", "/poll", "/response", "/exec", "/clear", "/sessions"],
      }));
      return;
    }

    // Sessions list
    if (path === "/sessions" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify({ sessions: this.getSessions() }));
      return;
    }

    // Plugin poll (long polling, session-aware)
    if (path === "/poll" && req.method === "GET") {
      var session = this.#getSession(sessionId);
      if (fileName) session.fileName = fileName;
      session.lastPollAt = Date.now();

      // Has work? respond immediately
      if (session.queue.some(function(r) { return session.pending.has(r.id); })) {
        this.#respondPoll(session, res);
        return;
      }
      // Long poll: hold until work or timeout
      if (session.longPoll) {
        clearTimeout(session.longPoll.timer);
        this.#respondPoll(session, session.longPoll.res);
      }
      var self = this;
      session.longPoll = {
        res: res,
        timer: setTimeout(function() {
          session.longPoll = null;
          self.#respondPoll(session, res);
        }, CONFIG.LONG_POLL_MS),
      };
      req.on("close", function() {
        if (session.longPoll && session.longPoll.res === res) {
          clearTimeout(session.longPoll.timer);
          session.longPoll = null;
        }
      });
      return;
    }

    // Plugin response
    if (path === "/response" && req.method === "POST") {
      var self = this;
      this.#readJson(req)
        .then(function(body) { self.#settle(body); res.writeHead(200); res.end(JSON.stringify({ ok: true })); })
        .catch(function(err) { res.writeHead(400); res.end(JSON.stringify({ error: err.message })); });
      return;
    }

    // Direct exec
    if (path === "/exec" && req.method === "POST") {
      var self = this;
      this.#readJson(req)
        .then(async function(body) {
          if (!self.isPluginConnected(sessionId)) {
            res.writeHead(503); res.end(JSON.stringify({ error: "Plugin not connected" })); return;
          }
          // /exec used to forward any operation name straight to the plugin,
          // bypassing the allowlist that guards the MCP path.
          if (ALL_OPS.indexOf(body.operation) === -1) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "Unknown operation: " + body.operation }));
            return;
          }
          try {
            var data = await self.sendOperation(body.operation, body.params || {}, sessionId);
            res.writeHead(200); res.end(JSON.stringify({ success: true, data: data }));
          } catch (e) {
            res.writeHead(200); res.end(JSON.stringify({ success: false, error: e.message }));
          }
        })
        .catch(function(err) { res.writeHead(400); res.end(JSON.stringify({ error: err.message })); });
      return;
    }

    // Health
    if (path === "/health" && req.method === "GET") {
      this.#cleanupSessions();
      var lp = this.lastPollAt;
      res.writeHead(200);
      res.end(JSON.stringify({
        pluginConnected: this.isPluginConnected(),
        queueLength: this.queueLength,
        pendingCount: this.pendingCount,
        lastPollAgoMs: lp ? Date.now() - lp : null,
        sessions: this.getSessions(),
        stats: this.stats,
      }));
      return;
    }

    // Clear queue
    if (path === "/clear" && req.method === "POST") {   // GET removed: an <img> tag could trigger it
      var cleared = this.clearQueue(sessionId);
      res.writeHead(200);
      res.end(JSON.stringify({ cleared: cleared, queueLength: 0, pendingCount: 0 }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async #killStaleBridges() {
    var port = CONFIG.PORT;
    try {
      var isZombie = await new Promise(function(resolve) {
        var req = http.get({ hostname: "127.0.0.1", port: port, path: "/health", timeout: 800 }, function(res) {
          var data = "";
          res.on("data", function(c) { data += c; });
          res.on("end", function() {
            try { var j = JSON.parse(data); resolve(j.pluginConnected === undefined); }
            catch(e) { resolve(false); }   // not JSON => not our bridge; never kill it
          });
        });
        req.on("error", function() { resolve(false); });
        req.on("timeout", function() { req.destroy(); resolve(false); });
      });
      if (!isZombie) return;   // someone else's healthy bridge — leave it alone
      // Zombie detected — kill ALL PIDs holding the port (was: only first PID)
      try {
        var m = await import("node:child_process");
        var pids = m.execSync("lsof -ti tcp:" + port + " 2>/dev/null", { encoding: "utf8" })
          .trim().split(/\s+/).filter(function(p) { return p && parseInt(p, 10) !== process.pid; });
        if (pids.length > 0) {
          for (var i = 0; i < pids.length; i++) {
            try { m.execSync("kill -9 " + pids[i] + " 2>/dev/null"); } catch(e) {}
          }
          process.stderr.write("[figma-bridge-mcp] Killed " + pids.length + " zombie(s) on port " + port + ": " + pids.join(",") + "\n");
          await new Promise(function(r) { setTimeout(r, 300); });
        }
      } catch(e) { /* ignore */ }
    } catch(e) { /* ignore */ }
  }

  start() {
    var self = this;
    return new Promise(async function(resolve) {
      await self.#killStaleBridges();

      var tryPort = function(port, attempt) {
        if (attempt >= CONFIG.PORT_RANGE) {
          process.stderr.write("[figma-bridge-mcp] All ports " + CONFIG.PORT + "-" + (CONFIG.PORT + CONFIG.PORT_RANGE - 1) + " in use.\n");
          resolve(self);
          return;
        }
        self.#server = http.createServer(function(req, res) { self.#route(req, res); });
        self.#server.once("error", function(err) {
          if (err.code === "EADDRINUSE") {
            process.stderr.write("[figma-bridge-mcp] Port " + port + " in use — trying " + (port + 1) + "...\n");
            tryPort(port + 1, attempt + 1);
          } else {
            process.stderr.write("[figma-bridge-mcp bridge] " + err.message + "\n");
            resolve(self);
          }
        });
        self.#server.once("listening", function() {
          self.#actualPort = port;
          // The plugin must call "localhost" (Figma's manifest allowlist), and on
          // many systems that resolves to ::1 first. Also listen on IPv6 loopback
          // so those clients connect; failure (IPv6 disabled/taken) is harmless.
          if (CONFIG.HOST === "127.0.0.1") {
            self.#server6 = http.createServer(function(req, res) { self.#route(req, res); });
            self.#server6.on("error", function() { self.#server6 = null; });
            self.#server6.listen({ port: port, host: "::1", ipv6Only: true });
          }
          resolve(self);
        });
        self.#server.listen(port, CONFIG.HOST);
      };
      tryPort(CONFIG.PORT, 0);
    });
  }

  stop() {
    // Close any long poll still held open first. server.close() waits for live
    // connections, so a parked poll keeps the process alive: the bridge appears
    // to hang on shutdown instead of exiting.
    for (var [, sess] of this.#sessions) {
      if (sess.longPoll) {
        clearTimeout(sess.longPoll.timer);
        try { sess.longPoll.res.end(JSON.stringify({ requests: [] })); } catch (e) {}
        sess.longPoll = null;
      }
    }
    if (this.#server) { this.#server.close(); this.#server = null; }
    if (this.#server6) { this.#server6.close(); this.#server6 = null; }
    for (var [id, sid] of this.#opToSession) {
      var s = this.#sessions.get(sid);
      if (s) {
        var p = s.pending.get(id);
        if (p) { clearTimeout(p.timer); p.reject(new Error("Bridge shutting down")); }
      }
    }
    this.#opToSession.clear();
    this.#sessions.clear();
  }
}
