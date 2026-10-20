// Vercel serverless proxy for the Mission Control dashboard.
//
// Vercel can host the dashboard (frontend/dist) but not the backend itself:
// the services, Redis, Prometheus and the chaos injector are long-running
// containers (the injector also needs the docker socket). So the backend runs
// elsewhere (e.g. an EC2 box running docker compose) and this function
// forwards the dashboard's control-API calls to it server-side. vercel.json
// rewrites
//   /api/chaos/<path>    -> /api/proxy?target=chaos&path=<path>     (chaos-injector :9000)
//   /api/security/<path> -> /api/proxy?target=security&path=<path>  (security-injector :9001)
//   /api/app/v1/<path>   -> /api/proxy?target=app&path=v1/<path>    (api-gateway :8080, the ride app)
//   /api/config          -> /api/proxy?target=config
//
// Which backend: the dashboard sends the address the operator typed into its
// "Backend" box in the X-RideFlow-Backend header (an EC2 public IP changes on
// every stop/start, so it can't live only in a deploy-time env var). Without
// that header, RIDEFLOW_BACKEND_URL is the default.
//
// Environment variables (Vercel project settings):
//   DASHBOARD_PASSWORD     required for the dashboard's Backend box; if set,
//                          /api/* requires HTTP Basic auth with this password
//                          (any username)
//   RIDEFLOW_BACKEND_URL   optional default backend, e.g. http://13.234.10.20
//   RIDEFLOW_CHAOS_URL     optional override of the default, <backend>:9000
//   RIDEFLOW_SECURITY_URL  optional override of the default, <backend>:9001

const crypto = require("crypto");

// Starting an experiment/attack holds the request open until the run ends
// (minutes for chaos experiments), far past a serverless timeout. The backend
// keeps running after the caller disconnects, so answer 202 after this long
// and let the dashboard's status polling show progress.
const RUN_WAIT_MS = 20000;
const REQUEST_TIMEOUT_MS = 8000;
const BACKEND_HEADER = "x-rideflow-backend";
const PORTS = { chaos: 9000, security: 9001, app: 8080, grafana: 3001, prometheus: 9090 };
const TARGETS = ["chaos", "security", "app"];

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function authorized(req) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return true;
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString();
  const given = decoded.slice(decoded.indexOf(":") + 1);
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(password).digest();
  return crypto.timingSafeEqual(a, b);
}

// The backend address comes from the browser, so this function would
// otherwise be an open relay into whatever it can reach. Only public hosts:
// no loopback, private, link-local (cloud metadata) or internal names.
function isBlockedHost(host) {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return true;
  if (host.includes(":") || host.startsWith("[")) return true; // IPv6: EC2 public addresses here are IPv4
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);
}

// Accepts "13.233.10.20", "http://13.233.10.20", "13.233.10.20:9000/x",
// "ec2-13-233-10-20.ap-south-1.compute.amazonaws.com"; returns a bare
// scheme://host (ports are fixed per target) or null.
function normalizeBackend(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "http://" + s;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  // WHATWG URL already canonicalises odd IPv4 forms (e.g. 2130706433 -> 127.0.0.1)
  const host = u.hostname.toLowerCase();
  if (!host || isBlockedHost(host)) return null;
  return `${u.protocol}//${host}`;
}

// -> { base, source } or { error: [status, detail, code] }
function resolveBackend(req) {
  const fromHeader = req.headers[BACKEND_HEADER];
  if (fromHeader) {
    if (!process.env.DASHBOARD_PASSWORD) {
      return { error: [403, "Set DASHBOARD_PASSWORD in the Vercel project's environment variables to connect a backend from the dashboard", "password_not_set"] };
    }
    const base = normalizeBackend(fromHeader);
    if (!base) {
      return { error: [400, `"${String(fromHeader).slice(0, 100)}" is not a usable public address. Enter the EC2 instance's Public IPv4 address, e.g. 13.233.10.20`, "invalid_backend"] };
    }
    return { base, source: "dashboard" };
  }
  const env = process.env.RIDEFLOW_BACKEND_URL;
  return env ? { base: normalizeBackend(env) || env.replace(/\/+$/, ""), source: "env" } : { base: null, source: null };
}

function withPort(base, port) {
  const u = new URL(base);
  u.port = String(port);
  return u.origin;
}

function upstreamFor(target, backend) {
  if (backend.source === "env") {
    if (target === "chaos" && process.env.RIDEFLOW_CHAOS_URL) return process.env.RIDEFLOW_CHAOS_URL;
    if (target === "security" && process.env.RIDEFLOW_SECURITY_URL) return process.env.RIDEFLOW_SECURITY_URL;
  }
  return backend.base ? withPort(backend.base, PORTS[target]) : null;
}

module.exports = async function handler(req, res) {
  if (!authorized(req)) {
    // No WWW-Authenticate header on purpose: it makes browsers pop their
    // native login dialog for every polled request. The dashboard asks for
    // the password itself and sends it as Basic auth (see apiFetch).
    return send(res, 401, { detail: "authentication required", code: "auth" });
  }

  const url = new URL(req.url, "http://localhost");
  const target = url.searchParams.get("target");
  const backend = resolveBackend(req);
  if (backend.error) {
    const [status, detail, code] = backend.error;
    return send(res, status, { detail, code });
  }

  if (target === "config") {
    return send(res, 200, {
      mode: "proxy",
      backend: backend.base,
      backendSource: backend.source,
      defaultBackend: process.env.RIDEFLOW_BACKEND_URL ? normalizeBackend(process.env.RIDEFLOW_BACKEND_URL) : null,
      dashboardBackendAllowed: Boolean(process.env.DASHBOARD_PASSWORD),
      grafanaUrl: backend.base ? withPort(backend.base, PORTS.grafana) : null,
      prometheusUrl: backend.base ? withPort(backend.base, PORTS.prometheus) : null,
    });
  }

  if (!TARGETS.includes(target)) {
    return send(res, 404, { detail: `unknown target ${target}`, code: "unknown_target" });
  }
  const upstream = upstreamFor(target, backend);
  if (!upstream) {
    return send(res, 503, {
      detail: "No backend set. Enter the EC2 instance's public IP in the Backend box at the top of the dashboard.",
      code: "backend_not_set",
    });
  }

  const path = url.searchParams.get("path") || "";
  if (!/^[A-Za-z0-9._\/-]*$/.test(path) || path.split("/").includes("..")) {
    return send(res, 400, { detail: "invalid path", code: "invalid_path" });
  }
  // the ride app may only reach the gateway's public API, not /admin or /metrics
  if (target === "app" && !path.startsWith("v1/")) {
    return send(res, 404, { detail: "not found", code: "invalid_path" });
  }
  const query = new URLSearchParams(url.searchParams);
  query.delete("target");
  query.delete("path");
  const qs = query.toString();
  const dest = `${upstream}/${path}${qs ? "?" + qs : ""}`;

  const init = { method: req.method, headers: {}, redirect: "manual" };
  // Authorization carries the dashboard password, so the ride app's own JWT
  // travels as X-App-Authorization and is restored for the gateway here
  if (target === "app" && req.headers["x-app-authorization"]) {
    init.headers.Authorization = req.headers["x-app-authorization"];
  }
  if (req.method !== "GET" && req.method !== "HEAD" && req.body !== undefined) {
    init.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    init.headers["Content-Type"] = req.headers["content-type"] || "application/json";
  }

  const isRun = req.method === "POST" && /\/run$/.test(path);
  const controller = new AbortController();
  init.signal = controller.signal;
  const upstreamCall = fetch(dest, init).then(async (r) => ({ status: r.status, text: await r.text() }));

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), isRun ? RUN_WAIT_MS : REQUEST_TIMEOUT_MS);
  });

  const unreachable = `Can't reach the ${target} service at ${upstream}. Check that the EC2 instance is running, `
    + `its containers are up, the security group allows port ${PORTS[target]}, and the IP in the Backend box is current.`;
  try {
    const result = await Promise.race([upstreamCall, timeout]);
    if (result) return send(res, result.status, result.text);
    if (isRun) {
      return send(res, 202, { started: true, detail: "run started; follow it on the dashboard" });
    }
    controller.abort();
    return send(res, 504, { detail: unreachable, code: "backend_unreachable" });
  } catch (e) {
    return send(res, 502, { detail: `${unreachable} (${e.cause?.code || e.message})`, code: "backend_unreachable" });
  } finally {
    clearTimeout(timer);
  }
};
