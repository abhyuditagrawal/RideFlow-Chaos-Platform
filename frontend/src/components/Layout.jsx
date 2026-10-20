import { createContext, useContext, useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  Activity, AlertTriangle, BarChart3, Car, ExternalLink, FileText, Gauge as GaugeIcon, Info, KeyRound, LayoutDashboard,
  Loader2, Menu, Network, Plug, ShieldAlert, Zap,
} from "lucide-react";
import { checkConnection, setBackend, setPassword } from "../lib/api";
import { useConn, usePoll } from "../lib/hooks";
import { Badge, Toasts } from "./ui";

// ---------- live status shared by every page ----------
const LiveCtx = createContext({ chaos: null, security: null, refreshChaos: () => {}, refreshSecurity: () => {} });
export const useLive = () => useContext(LiveCtx);

const PAGES = [
  { to: "/", label: "Mission Control", icon: LayoutDashboard, sub: "Live health of the whole platform" },
  { to: "/rides", label: "Ride App", icon: Car, sub: "Book real rides through the microservices" },
  { to: "/chaos", label: "Chaos Lab", icon: Zap, sub: "Break things on purpose, measure recovery" },
  { to: "/security", label: "Security Lab", icon: ShieldAlert, sub: "Attack the app, score its defences" },
  { to: "/observability", label: "Observability", icon: BarChart3, sub: "Per-service RED metrics and breakers" },
  { to: "/reports", label: "Reports", icon: FileText, sub: "Resilience scorecard and exports" },
  { to: "/architecture", label: "Architecture", icon: Network, sub: "How RideFlow is built and why" },
];

function Sidebar({ open, onNavigate }) {
  const conn = useConn();
  const { chaos } = useLive();
  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <div className="brand">
        <div className="brand-logo"><Car size={20} /></div>
        <div>
          <div className="brand-name">RideFlow</div>
          <div className="brand-sub">Chaos & Security Platform</div>
        </div>
      </div>
      <nav className="nav">
        <div className="nav-section">Operate</div>
        {PAGES.slice(0, 4).map((p) => (
          <NavLink key={p.to} to={p.to} end onClick={onNavigate}>
            <p.icon size={17} />{p.label}
            {p.to === "/chaos" && chaos?.activeRun && <span className="count"><span className="dot blue pulse" /></span>}
          </NavLink>
        ))}
        <div className="nav-section">Analyse</div>
        {PAGES.slice(4).map((p) => (
          <NavLink key={p.to} to={p.to} onClick={onNavigate}><p.icon size={17} />{p.label}</NavLink>
        ))}
      </nav>
      <div className="spacer" />
      <div className="side-foot">
        {conn.grafanaUrl && <a href={conn.grafanaUrl} target="_blank" rel="noreferrer"><Activity size={14} />Grafana <ExternalLink size={11} /></a>}
        {conn.prometheusUrl && <a href={conn.prometheusUrl} target="_blank" rel="noreferrer"><GaugeIcon size={14} />Prometheus <ExternalLink size={11} /></a>}
        <span className="dim tiny">{conn.mode === "proxy" ? "via Vercel proxy → AWS EC2" : conn.mode === "direct" ? "direct to Docker stack" : ""}</span>
      </div>
    </aside>
  );
}

function BackendBox() {
  const conn = useConn();
  const [value, setValue] = useState(conn.backend || "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!conn.backend && conn.defaultBackend && !value) setValue(conn.defaultBackend.replace(/^https?:\/\//, ""));
  }, [conn.defaultBackend]); // eslint-disable-line react-hooks/exhaustive-deps
  const tone = conn.status === "ok" ? "green" : conn.status === "checking" ? "amber" : "red";
  return (
    <form className="conn" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await setBackend(value); setBusy(false); }}>
      <span className={`dot ${tone} ${conn.status === "checking" ? "pulse" : ""}`} title={conn.status} />
      <span className="label">Backend</span>
      <input className="input mono" value={value} onChange={(e) => setValue(e.target.value)} placeholder="EC2 public IP" spellCheck={false} />
      <button className="btn primary sm" disabled={busy}>{busy ? <Loader2 size={14} className="spin" /> : <Plug size={14} />}Connect</button>
    </form>
  );
}

function StatusPills() {
  const { chaos } = useLive();
  if (!chaos) return null;
  const sim = chaos.simulator;
  return (
    <>
      {chaos.activeRun && <Badge tone="blue" dot>Running: {chaos.activeRun.experimentId}</Badge>}
      <Badge tone={sim?.running ? "green" : "gray"} dot>{sim?.running ? `Traffic ${sim.rps} rps` : "Traffic off"}</Badge>
      <Badge tone={chaos.enabled ? "violet" : "red"}>{chaos.enabled ? "Chaos armed" : "Chaos disabled"}</Badge>
    </>
  );
}

function PasswordModal() {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const conn = useConn();
  return (
    <div className="modal-back">
      <form className="modal" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await setPassword(pw); setBusy(false); }}>
        <div className="brand-logo" style={{ marginBottom: 16 }}><KeyRound size={20} /></div>
        <h2>RideFlow Mission Control</h2>
        <p className="muted" style={{ marginTop: 0 }}>This dashboard can run chaos experiments against live infrastructure, so it's password protected.</p>
        <input className="input" type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Dashboard password" style={{ width: "100%" }} />
        {conn.status === "auth" && pw === "" && busy === false && <div className="tiny dim mt-sm">The password is the DASHBOARD_PASSWORD value set in Vercel.</div>}
        <button className="btn primary block lg mt" disabled={!pw || busy}>{busy ? "Checking…" : "Unlock"}</button>
      </form>
    </div>
  );
}

export function Layout({ children }) {
  const conn = useConn();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const page = PAGES.find((p) => (p.to === "/" ? location.pathname === "/" : location.pathname.startsWith(p.to))) || PAGES[0];

  const chaos = usePoll("/chaos/status", 2000);
  const security = usePoll("/security/status", 4000);

  useEffect(() => { checkConnection(); }, []);
  // while disconnected, retry quietly (e.g. the EC2 instance is still booting)
  useEffect(() => {
    if (conn.status !== "down") return undefined;
    const id = setInterval(checkConnection, 10000);
    return () => clearInterval(id);
  }, [conn.status]);

  return (
    <LiveCtx.Provider value={{ chaos: chaos.data, security: security.data, refreshChaos: chaos.refresh, refreshSecurity: security.refresh }}>
      <div className="shell">
        <Sidebar open={open} onNavigate={() => setOpen(false)} />
        <div className="main">
          <header className="topbar">
            <button className="btn ghost sm menu-btn" onClick={() => setOpen(!open)} aria-label="menu"><Menu size={16} /></button>
            <div>
              <h1>{page.label}</h1>
              <div className="sub">{page.sub}</div>
            </div>
            <div className="right">
              <StatusPills />
              {conn.mode === "proxy" && <BackendBox />}
            </div>
          </header>
          {conn.status === "down" && (
            <div className="banner"><AlertTriangle size={18} /><div><b>Not connected to the backend.</b> {conn.detail}</div></div>
          )}
          {conn.status === "checking" && !chaos.data && (
            <div className="banner info"><Info size={18} /><div>Connecting to the backend…</div></div>
          )}
          <main className="content">{children}</main>
        </div>
      </div>
      {conn.status === "auth" && <PasswordModal />}
      <Toasts />
    </LiveCtx.Provider>
  );
}
