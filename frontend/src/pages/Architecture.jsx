import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Boxes, Cloud, GitBranch, Layers, Lightbulb, Route, Scale, Workflow } from "lucide-react";
import Topology from "../components/Topology";
import { Card, ChartTooltip } from "../components/ui";
import { LAYERS, SERVICES } from "../lib/catalog";

const FLOW = [
  ["Rider", "POST /v1/rides with pickup and drop to the api-gateway (Go)."],
  ["api-gateway", "Rate-limits per client IP, then forwards to ride-service through its own circuit breaker."],
  ["ride-service", "Asks pricing-service for a quote. If pricing fails, uses the last known fare instead."],
  ["ride-service", "Asks driver-service to match the nearest driver from the Redis geo index."],
  ["driver-service", "Returns a driver and ETA, or nothing, in which case the ride is saved as PENDING_MATCH and retried."],
  ["Rider", "Gets 201 Created (matched) or 202 Accepted (waiting for a driver)."],
];

const DECISIONS = [
  ["Custom chaos injector", "Chaos Mesh and LitmusChaos inject faults but don't measure recovery against a hypothesis. That measurement is this project's output."],
  ["Warm standby, not active-active", "The backup region runs at minimum size and scales on failover. Much cheaper, at the cost of a slower RTO."],
  ["EKS over self-managed Kubernetes", "A managed control plane; running our own would take weeks and isn't the point."],
  ["DynamoDB Global Tables", "Multi-region replication built in, unlike RDS which needs manual failover."],
  ["Polyglot services", "Go, Node.js and Python show that containers make the runtime irrelevant to deployment."],
  ["Vercel + EC2 split", "Vercel serves the React app and a password-protected Node proxy; EC2 runs the long-lived containers Vercel can't."],
];

const STACK = [
  ["Frontend", "React 18, Vite, React Router, Recharts, Leaflet"],
  ["Edge / BFF", "Node.js serverless proxy on Vercel (auth, backend routing, SSRF guard)"],
  ["Services", "Go (gateway, drivers) · Node.js/Express (users) · Python/FastAPI (rides, pricing)"],
  ["Engines", "Python/FastAPI chaos injector + security injector, APScheduler"],
  ["Data", "Redis geo index · in-memory stores (DynamoDB in the cloud design)"],
  ["Observability", "Prometheus (recording + alert rules), Grafana (3 dashboards, annotations)"],
  ["Infrastructure", "Docker, Docker Compose, Terraform (VPC, EKS, Route 53, DynamoDB), Helm"],
  ["CI/CD", "GitHub Actions: build, Trivy image scan, resilience-gated deploy"],
];

export default function Architecture() {
  const layerData = LAYERS.map((l) => ({ ...l, name: `${l.id} ${l.mech}` })).sort((a, b) => a.t - b.t);
  return (
    <div className="stack">
      <div className="hero">
        <h2>Resilience you can measure</h2>
        <p>RideFlow is a ride-hailing backend built to be broken on purpose. A chaos engine injects real faults and measures how fast the platform notices (MTTD) and heals (MTTR); a security engine attacks the platform's own login, tokens and APIs. Both are driven from this dashboard, so "the system is reliable and secure" becomes a set of numbers.</p>
      </div>

      <div className="grid">
        <Card className="c-7" title="Service architecture" icon={GitBranch}>
          <Topology health={Object.fromEntries(SERVICES.map((s) => [s.id, true]))} trafficOn />
        </Card>
        <Card className="c-5" title="Request flow: booking a ride" icon={Route}>
          <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 10 }}>
            {FLOW.map(([who, what], i) => <li key={i} className="small"><b>{who}</b> <span className="muted">{what}</span></li>)}
          </ol>
        </Card>
      </div>

      <div className="grid">
        <Card className="c-7" title="Self-healing happens in layers" icon={Layers} hint="typical time to act, seconds">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={layerData} layout="vertical" margin={{ left: 40, right: 16, top: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 4" horizontal={false} />
              <XAxis type="number" unit="s" tickLine={false} axisLine={false} />
              <YAxis type="category" dataKey="name" width={190} tickLine={false} axisLine={false} />
              <Tooltip cursor={{ fill: "rgba(91,140,255,0.06)" }} content={<ChartTooltip formatters={{ t: (v) => `~${v}s` }} />} />
              <Bar dataKey="t" name="Acts within" radius={[0, 6, 6, 0]}>
                {layerData.map((l) => <Cell key={l.id} fill={l.t < 15 ? "#34d399" : l.t < 80 ? "#5b8cff" : "#f87171"} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card className="c-5" title="The core finding" icon={Lightbulb}>
          <p className="desc" style={{ marginTop: 0 }}><b style={{ color: "var(--text)" }}>The closer a fix is to the fault, the faster the recovery.</b> A circuit breaker inside the app reacts in about a second; DNS failover between regions takes a minute or more, roughly 100× slower.</p>
          <p className="desc">So resilience should be built in at the lowest possible layer, and region failover is a last resort, not the plan.</p>
          <table className="table mt">
            <thead><tr><th>Layer</th><th>Detects</th><th>Acts in</th></tr></thead>
            <tbody>{LAYERS.map((l) => <tr key={l.id}><td className="small"><span className="code-chip">{l.id}</span> {l.mech}</td><td className="small muted">{l.detects}</td><td className="small">{l.time}</td></tr>)}</tbody>
          </table>
        </Card>
      </div>

      <div className="grid">
        <Card className="c-6" title="Deployment" icon={Cloud}>
          <svg viewBox="0 0 560 250" width="100%">
            {[
              [20, 95, "Browser", "React SPA"], [200, 30, "Vercel CDN", "static React build"], [200, 160, "Vercel function", "Node.js proxy · password"],
              [400, 95, "AWS EC2", "Docker Compose · 11 containers"],
            ].map(([x, y, a, b]) => (
              <g key={a} transform={`translate(${x},${y})`}>
                <rect width="140" height="58" rx="12" className="arch-node" strokeWidth="1.5" />
                <text x="70" y="26" textAnchor="middle" className="arch-label">{a}</text>
                <text x="70" y="42" textAnchor="middle" className="arch-sub">{b}</text>
              </g>
            ))}
            <path d="M160 115 L200 65" stroke="#5b8cff" strokeWidth="2" className="flow" fill="none" />
            <path d="M160 132 L200 185" stroke="#5b8cff" strokeWidth="2" className="flow" fill="none" />
            <path d="M340 189 L400 135" stroke="#a78bfa" strokeWidth="2" className="flow" fill="none" />
            <text x="170" y="245" className="arch-sub">HTTPS to Vercel · HTTP to EC2 ports 9000/9001/8080 (server-side, no mixed content)</text>
          </svg>
          <div className="tiny dim">The full design (two EKS regions, Route 53 failover, DynamoDB Global Tables) is written as Terraform + Helm in the repo; it wasn't applied because of cost.</div>
        </Card>
        <Card className="c-6" title="Technology stack" icon={Boxes}>
          <table className="table"><tbody>{STACK.map(([k, v]) => <tr key={k}><td className="small" style={{ width: 130 }}><b>{k}</b></td><td className="small muted">{v}</td></tr>)}</tbody></table>
        </Card>
      </div>

      <div className="grid">
        <Card className="c-6" title="Design decisions" icon={Scale} hint="from docs/adr">
          <div className="col gap-lg">
            {DECISIONS.map(([t, d]) => <div key={t}><b className="small">{t}</b><div className="small muted">{d}</div></div>)}
          </div>
        </Card>
        <Card className="c-6" title="Chaos experiment lifecycle" icon={Workflow}>
          <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 10 }} className="small">
            <li><b>Validate</b> <span className="muted">the steady state holds before touching anything (error rate &lt; 1%, p99 &lt; 1.5 s).</span></li>
            <li><b>Check blast radius</b> <span className="muted">so the fault can't exceed its declared scope.</span></li>
            <li><b>Inject</b> <span className="muted">the fault and record t0; the fault is persisted first so a crash can't orphan it.</span></li>
            <li><b>Monitor</b> <span className="muted">every 2 s; the first breach gives MTTD. An error rate above 25% for 15 s auto-aborts.</span></li>
            <li><b>Revert</b> <span className="muted">the fault (or the operator hits Emergency Abort).</span></li>
            <li><b>Measure recovery</b> <span className="muted">once the steady state holds for 30 s; that gives MTTR. No breach means "no impact".</span></li>
            <li><b>Report</b> <span className="muted">pass or fail against the hypothesis, with Grafana annotations on the timeline.</span></li>
          </ol>
        </Card>
      </div>
    </div>
  );
}
