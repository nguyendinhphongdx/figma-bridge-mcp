// Server-side HTTP fetch for images and icons. Never exposed inside the sandbox.
//
// Code in figma_write can pass any URL to loadImage, so this must not become a
// proxy into the user's network: only http(s) is allowed, and the resolved
// address must be public. Checking inside the socket `lookup` hook (rather than
// resolving first and connecting later) closes the DNS-rebinding window, and the
// same check runs again on every redirect hop.
// Set FIGMA_MCP_ALLOW_PRIVATE_FETCH=1 to allow private/loopback hosts (e.g. a local asset server).
import https from "node:https";
import http from "node:http";
import dns from "node:dns";
import net from "node:net";

function isPrivateAddress(addr) {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||   // CGNAT
      (a === 169 && b === 254) ||             // link-local, incl. cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224;                               // multicast / reserved
  }
  const v = addr.toLowerCase();
  if (v === "::" || v === "::1") return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  return v.startsWith("fc") || v.startsWith("fd") || /^fe[89ab]/.test(v);
}

const allowPrivate = () => process.env.FIGMA_MCP_ALLOW_PRIVATE_FETCH === "1";

function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (!allowPrivate() && list.some((a) => isPrivateAddress(a.address))) {
      return callback(new Error("Blocked: URL resolves to a private or loopback address"));
    }
    callback(null, address, family);
  });
}

export function httpFetch(url, maxBytes = 10_000_000, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error("Invalid URL")); }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return reject(new Error("Only http(s) URLs are allowed"));
    }
    // A literal IP never goes through `lookup`, so check it up front.
    const bare = parsed.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(bare) && !allowPrivate() && isPrivateAddress(bare)) {
      return reject(new Error("Blocked: URL points to a private or loopback address"));
    }

    const client = parsed.protocol === "https:" ? https : http;
    const req = client.get(parsed, { timeout: 15000, lookup: guardedLookup }, (res) => {
      // Follow redirects (up to 3); Location may be relative, and is re-validated above.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error("Too many redirects"));
        let next;
        try { next = new URL(res.headers.location, parsed).href; } catch { return reject(new Error("Invalid redirect")); }
        return httpFetch(next, maxBytes, redirectsLeft - 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { req.destroy(); reject(new Error("Response too large")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// Normalize arcData keys: startAngle/endAngle (SVG-style) → startingAngle/endingAngle (Figma API)
// Applied server-side so tests and real plugin both behave consistently.
export function normalizeArcData(arcData) {
  if (!arcData || typeof arcData !== "object") return arcData;
  return {
    startingAngle: arcData.startingAngle !== undefined ? arcData.startingAngle
                 : (arcData.startAngle   !== undefined ? arcData.startAngle : 0),
    endingAngle:   arcData.endingAngle   !== undefined ? arcData.endingAngle
                 : (arcData.endAngle     !== undefined ? arcData.endAngle   : Math.PI * 2),
    innerRadius:   arcData.innerRadius   !== undefined ? arcData.innerRadius : 0,
  };
}
