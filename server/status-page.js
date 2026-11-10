// Temporary status page served by the bridge at /ui (and at / for browsers).
// Static: it fetches /health from the same origin and renders with textContent,
// never innerHTML, because session file names come from the plugin.
export const STATUS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bridge MCP for Figma — status</title>
<style>
  :root { --bg:#0f1117; --panel:#181b24; --line:#2a2f3d; --text:#e6e8ee; --mute:#8b93a7; --ok:#22c55e; --bad:#ef4444; --warn:#f59e0b; --accent:#8b5cf6; }
  @media (prefers-color-scheme: light) { :root { --bg:#f5f6fa; --panel:#fff; --line:#e1e4ee; --text:#1c2030; --mute:#657089; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui,Segoe UI,sans-serif; }
  main { max-width:760px; margin:0 auto; padding:32px 16px; }
  h1 { font-size:20px; margin:0 0 4px; } .sub { color:var(--mute); margin:0 0 24px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px 18px; margin-bottom:16px; }
  .row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .dot { width:12px; height:12px; border-radius:50%; background:var(--mute); flex:none; }
  .dot.ok { background:var(--ok); } .dot.bad { background:var(--bad); } .dot.warn { background:var(--warn); }
  .big { font-size:17px; font-weight:600; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:12px; }
  .k { color:var(--mute); font-size:12px; text-transform:uppercase; letter-spacing:.04em; } .v { font-size:20px; font-weight:600; }
  table { width:100%; border-collapse:collapse; font-size:14px; } th,td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); }
  th { color:var(--mute); font-weight:500; font-size:12px; text-transform:uppercase; }
  button { background:var(--accent); color:#fff; border:0; border-radius:8px; padding:8px 14px; font:inherit; cursor:pointer; }
  button.ghost { background:transparent; color:var(--text); border:1px solid var(--line); }
  code { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:1px 6px; font-size:13px; }
  .hint { color:var(--mute); font-size:13px; margin-top:8px; }
</style>
</head>
<body>
<main>
  <h1>Bridge MCP for Figma</h1>
  <p class="sub" id="sub">Connecting…</p>

  <div class="card">
    <div class="row"><span class="dot" id="pdot"></span><span class="big" id="ptext">Checking…</span></div>
    <p class="hint" id="phint"></p>
  </div>

  <div class="card grid">
    <div><div class="k">Port</div><div class="v" id="port">–</div></div>
    <div><div class="k">Queued</div><div class="v" id="queue">–</div></div>
    <div><div class="k">Pending</div><div class="v" id="pending">–</div></div>
    <div><div class="k">Ops done</div><div class="v" id="ops">–</div></div>
    <div><div class="k">Avg latency</div><div class="v" id="lat">–</div></div>
  </div>

  <div class="card">
    <div class="row" style="justify-content:space-between"><span class="big">Sessions</span><button class="ghost" id="clear">Clear queue</button></div>
    <table><thead><tr><th>File</th><th>Id</th><th>State</th><th>Last poll</th><th>Ops</th></tr></thead><tbody id="sessions"></tbody></table>
    <p class="hint" id="nosess"></p>
  </div>

  <p class="hint">Refreshes every 2 s · raw data: <code>/health</code> · <code>/sessions</code></p>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var failures = 0;
  function td(text) { var c = document.createElement("td"); c.textContent = text; return c; }
  function ago(ms) { return ms == null ? "never" : ms < 1500 ? "just now" : Math.round(ms / 1000) + " s ago"; }

  function render(h) {
    failures = 0;
    $("sub").textContent = "Server " + (h.version ? "v" + h.version + " · " : "") + "listening on port " + h.port;
    var ok = h.pluginConnected;
    $("pdot").className = "dot " + (ok ? "ok" : "warn");
    $("ptext").textContent = ok ? "Figma plugin connected" : "Waiting for the Figma plugin";
    $("phint").textContent = ok ? "" : "In Figma Desktop run Plugins → Development → Bridge MCP for Figma, then press Reconnect.";
    $("port").textContent = h.port;
    $("queue").textContent = h.queueLength;
    $("pending").textContent = h.pendingCount;
    $("ops").textContent = h.stats ? h.stats.ops : 0;
    $("lat").textContent = h.stats ? h.stats.avgLatencyMs + " ms" : "–";
    var body = $("sessions"); body.textContent = "";
    (h.sessions || []).forEach(function (s) {
      var tr = document.createElement("tr");
      tr.appendChild(td(s.fileName)); tr.appendChild(td(s.id));
      tr.appendChild(td(s.connected ? "connected" : "idle"));
      tr.appendChild(td(ago(s.lastPollAgoMs))); tr.appendChild(td(String(s.ops)));
      body.appendChild(tr);
    });
    $("nosess").textContent = (h.sessions || []).length ? "" : "No plugin has polled this server yet.";
  }

  function fail() {
    failures++;
    $("pdot").className = "dot bad";
    $("ptext").textContent = "Cannot reach the bridge";
    $("phint").textContent = "The server stopped or this page lost contact (" + failures + " failed refresh" + (failures > 1 ? "es" : "") + ").";
  }

  function tick() {
    fetch("/health", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (h) { return fetch("/", { headers: { Accept: "application/json" }, cache: "no-store" }).then(function (r) { return r.json(); }).then(function (root) { h.version = root.version; return h; }); })
      .then(function (h) { h.port = location.port || h.port; render(h); })
      .catch(fail);
  }

  $("clear").addEventListener("click", function () {
    fetch("/clear", { method: "POST" }).then(tick).catch(fail);
  });
  tick(); setInterval(tick, 2000);
})();
</script>
</body>
</html>
`;
