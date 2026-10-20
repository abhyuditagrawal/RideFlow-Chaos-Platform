import { useEffect, useState, useSyncExternalStore } from "react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";

export function Card({ title, icon: Icon, hint, actions, children, className = "", style }) {
  return (
    <section className={`card ${className}`} style={style}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h3>{Icon && <Icon size={16} />}{title}</h3>}
          {hint && <span className="hint">{hint}</span>}
          {actions && <div className="actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, unit, foot, icon: Icon, color = "var(--blue)", spark, sparkKey, tone }) {
  return (
    <div className="card kpi">
      <div className="label">
        {Icon && <span className="kpi-icon" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}><Icon size={16} /></span>}
        {label}
      </div>
      <div className={`value ${tone || ""}`}>{value}{unit && <small>{unit}</small>}</div>
      {foot && <div className="foot">{foot}</div>}
      <div style={{ height: 46 }} />
      {spark && spark.length > 1 && (
        <div className="spark">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={spark} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={`sg-${sparkKey}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.45} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey={sparkKey} stroke={color} strokeWidth={1.8} fill={`url(#sg-${sparkKey})`} isAnimationActive={false} connectNulls />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

const TONES = {
  pass: "green", defended: "green", ok: "green", up: "green", closed: "green", MATCHED: "green", COMPLETED: "green",
  fail: "red", vulnerable: "red", down: "red", open: "red", CANCELLED: "gray", error: "red",
  aborted: "amber", partial: "amber", half_open: "amber", PENDING_MATCH: "amber", QUOTED: "blue",
  running: "blue", unknown: "gray", critical: "red", high: "red", medium: "amber", low: "blue", info: "gray",
};
export function Badge({ children, tone, value, dot }) {
  const t = tone || TONES[value] || "gray";
  return (
    <span className={`badge ${t}`}>
      {dot && <span className={`dot ${t}`} />}
      {children ?? String(value ?? "—").replace(/_/g, " ")}
    </span>
  );
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

export function Gauge({ value, label, size = 150 }) {
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  const r = size / 2 - 12;
  const c = 2 * Math.PI * r;
  const color = value == null ? "var(--dim-2)" : v >= 80 ? "var(--green)" : v >= 50 ? "var(--amber)" : "var(--red)";
  return (
    <div className="gauge-wrap" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="#1a2338" strokeWidth="12" fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth="12" fill="none" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} style={{ transition: "stroke-dashoffset 0.8s ease, stroke 0.3s" }} />
      </svg>
      <div className="gv"><div><b style={{ color }}>{value == null ? "—" : `${Math.round(v)}%`}</b><span className="muted small">{label}</span></div></div>
    </div>
  );
}

export function ChartTooltip({ active, payload, label, formatLabel, formatters = {} }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="tt">
      <div className="muted tiny" style={{ marginBottom: 4 }}>{formatLabel ? formatLabel(label) : label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ color: p.color }}>
          {p.name}: <b>{formatters[p.dataKey] ? formatters[p.dataKey](p.value) : p.value}</b>
        </div>
      ))}
    </div>
  );
}

// ---------- toasts ----------
let toasts = [];
const toastListeners = new Set();
function emitToasts() { toastListeners.forEach((f) => f()); }
export function toast(title, body, kind = "info") {
  const id = Math.random().toString(36).slice(2);
  toasts = [...toasts, { id, title, body, kind }];
  emitToasts();
  setTimeout(() => { toasts = toasts.filter((t) => t.id !== id); emitToasts(); }, kind === "error" ? 7000 : 4500);
}
export function Toasts() {
  const list = useSyncExternalStore((f) => { toastListeners.add(f); return () => toastListeners.delete(f); }, () => toasts);
  return (
    <div className="toasts">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}><b>{t.title}</b>{t.body && <span className="muted">{t.body}</span>}</div>
      ))}
    </div>
  );
}

export function useTicker(ms) {
  const [, setN] = useState(0);
  useEffect(() => { const id = setInterval(() => setN((n) => n + 1), ms); return () => clearInterval(id); }, [ms]);
}
