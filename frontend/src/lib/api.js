// Every call goes to same-origin /api/*:
//   - on Vercel, api/proxy.js forwards to the EC2 backend (needs the dashboard
//     password and the backend address typed into the Backend box)
//   - in docker compose, the dashboard container's nginx forwards directly
// /api/chaos -> chaos-injector, /api/security -> security-injector,
// /api/app -> api-gateway (the ride-hailing app itself).

const CONN_ERRORS = ["backend_unreachable", "backend_not_set", "invalid_backend", "password_not_set"];

function load(storage, key) {
  try { return window[storage].getItem(key) || ""; } catch (e) { return ""; }
}
function save(storage, key, value) {
  try {
    if (value) window[storage].setItem(key, value);
    else window[storage].removeItem(key);
  } catch (e) { /* private mode etc. */ }
}

// ---------- tiny store with subscribe, for useSyncExternalStore ----------
let state = {
  mode: null,          // "direct" (compose/nginx) | "proxy" (Vercel) | null until /api/config answers
  status: "checking",  // checking | ok | down | auth
  detail: "",
  backend: load("localStorage", "rideflow-backend"),
  defaultBackend: null,
  grafanaUrl: null,
  prometheusUrl: null,
};
const listeners = new Set();
export function getConn() { return state; }
export function subscribeConn(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function setState(patch) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

let authHeader = load("sessionStorage", "rideflow-auth");

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = "GET", body, appToken, timeoutMs = 30000 } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (authHeader) headers.Authorization = authHeader;
  if (state.backend) headers["X-RideFlow-Backend"] = state.backend;
  if (appToken) headers["X-App-Authorization"] = "Bearer " + appToken;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let r;
  try {
    r = await fetch("/api" + path, {
      method, headers, signal: ctrl.signal,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(e.name === "AbortError" ? "Request timed out" : "Network error: " + e.message, 0, "network");
  } finally {
    clearTimeout(timer);
  }

  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }

  if (r.status === 401 && data && data.code === "auth") {
    setState({ status: "auth", detail: "Dashboard password required" });
    throw new ApiError("Dashboard password required", 401, "auth");
  }
  if (!r.ok) {
    const code = data && data.code;
    const detail = (data && (data.detail || data.error)) || (typeof data === "string" && data) || `HTTP ${r.status}`;
    if (CONN_ERRORS.includes(code)) setState({ status: "down", detail });
    throw new ApiError(typeof detail === "string" ? detail : JSON.stringify(detail), r.status, code);
  }
  return data;
}

export async function checkConnection() {
  if (state.status !== "ok") setState({ status: "checking" });
  try {
    const cfg = await api("/config");
    const direct = cfg.mode === "direct";
    const host = window.location.hostname;
    setState({
      mode: direct ? "direct" : "proxy",
      defaultBackend: cfg.defaultBackend || null,
      grafanaUrl: direct ? `http://${host}:3001` : cfg.grafanaUrl,
      prometheusUrl: direct ? `http://${host}:9090` : cfg.prometheusUrl,
    });
    if (!direct && !state.backend && !cfg.backend) {
      setState({ status: "down", detail: "No backend set. Start your EC2 instance, copy its Public IPv4 address into the Backend box and press Connect." });
      return false;
    }
    await Promise.all([api("/chaos/healthz", { timeoutMs: 12000 }), api("/security/healthz", { timeoutMs: 12000 })]);
    setState({ status: "ok", detail: "" });
    return true;
  } catch (e) {
    if (e.code !== "auth" && state.status !== "down") setState({ status: "down", detail: e.message });
    return false;
  }
}

export function setBackend(addr) {
  const backend = addr.trim();
  save("localStorage", "rideflow-backend", backend);
  setState({ backend });
  return checkConnection();
}

export function setPassword(pw) {
  authHeader = "Basic " + btoa(unescape(encodeURIComponent("dashboard:" + pw)));
  save("sessionStorage", "rideflow-auth", authHeader);
  return checkConnection();
}
