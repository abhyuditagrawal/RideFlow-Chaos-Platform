import { useState } from "react";
import { Activity, AlertOctagon, CircuitBoard, ExternalLink, Gauge as GaugeIcon, Scale, Server } from "lucide-react";
import { useLive } from "../components/Layout";
import TrafficChart from "../components/TrafficChart";
import { Badge, Card, Empty } from "../components/ui";
import { SERVICES } from "../lib/catalog";
import { useConn, usePoll } from "../lib/hooks";
import { fmtMs, fmtNum, fmtPct } from "../lib/format";

const STEADY = [
  { label: "Gateway error rate", key: "errorRate", op: "<", limit: 0.01, fmt: (v) => fmtPct(v) },
  { label: "p99 latency", key: "p99LatencyMs", op: "<", limit: 1500, fmt: fmtMs },
  { label: "Rides created per minute", key: "ridesPerMin", op: ">", limit: 45, fmt: (v) => fmtNum(v, 1) },
];

export default function Observability() {
  const conn = useConn();
  const { chaos } = useLive();
  const [minutes, setMinutes] = useState(15);
  const history = usePoll(`/chaos/metrics/history?minutes=${minutes}`, 10000);
  const services = usePoll("/chaos/metrics/services", 4000);
  const breakers = usePoll("/chaos/breakers", 3000);
  const summary = usePoll("/chaos/metrics/summary", 3000);
  const pts = history.data?.points || [];
  const m = summary.data || {};

  const range = (
    <div className="seg">
      {[5, 15, 60].map((n) => <button key={n} className={minutes === n ? "on" : ""} onClick={() => setMinutes(n)}>{n} min</button>)}
    </div>
  );

  return (
    <div className="stack">
      <div className="grid">
        <Card className="c-8" title="Steady state, right now" icon={Scale} hint="what every chaos experiment checks before, during and after a fault">
          <div className="grid">
            {STEADY.map((s) => {
              const v = m[s.key];
              const ok = v == null ? null : s.op === "<" ? v < s.limit : v > s.limit;
              return (
                <div key={s.key} className="c-4 svc" style={{ borderColor: ok === false ? "rgba(248,113,113,.5)" : undefined }}>
                  <div className="row between"><span className="small muted">{s.label}</span>{ok == null ? <Badge tone="gray">no data</Badge> : <Badge tone={ok ? "green" : "red"}>{ok ? "holds" : "breached"}</Badge>}</div>
                  <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>{v == null ? "—" : s.fmt(v)}</div>
                  <div className="tiny dim">must be {s.op} {s.fmt(s.limit)}</div>
                </div>
              );
            })}
          </div>
          <div className="tiny dim mt">The rides-per-minute condition only applies to E5; at the simulator's default 4 rps the platform creates about 240 rides/min.</div>
        </Card>
        <Card className="c-4" title="Tools" icon={ExternalLink}>
          <div className="col">
            {conn.grafanaUrl && <a className="btn block" href={conn.grafanaUrl} target="_blank" rel="noreferrer"><Activity size={15} />Open Grafana dashboards</a>}
            {conn.prometheusUrl && <a className="btn block" href={conn.prometheusUrl} target="_blank" rel="noreferrer"><GaugeIcon size={15} />Open Prometheus</a>}
            <div className="tiny dim">Grafana login: admin / admin. Three provisioned dashboards: Platform Overview, Chaos Timeline (with fault annotations), Recovery Analysis.</div>
            <div className="tiny dim">Backend: {chaos?.backend === "LocalBackend" ? "Docker (single host)" : chaos?.backend || "—"}</div>
          </div>
        </Card>
      </div>

      <div className="grid">
        <Card className="c-6" title="Throughput" icon={Activity} actions={range}>
          {pts.length ? <TrafficChart points={pts} series={["rps", "ridesPerMin"]} height={260} /> : <Empty>No data yet.</Empty>}
        </Card>
        <Card className="c-6" title="Latency & errors" icon={AlertOctagon} actions={range}>
          {pts.length ? <TrafficChart points={pts} series={["p50Ms", "p99Ms"]} height={260} /> : <Empty>No data yet.</Empty>}
        </Card>
      </div>

      <div className="grid">
        <Card className="c-8" title="Per-service RED metrics" icon={Server} hint="Rate · Errors · Duration, scraped by Prometheus every 5 s">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Service</th><th>Language</th><th>Role</th><th>Status</th><th className="num">Req/s</th><th className="num">Errors</th><th className="num">p99</th></tr></thead>
              <tbody>
                {SERVICES.map((s) => {
                  const mm = services.data?.services?.[s.id] || {};
                  const up = chaos?.serviceHealth?.[s.id];
                  return (
                    <tr key={s.id}>
                      <td><b className="small">{s.id}</b><div className="tiny dim">:{s.port}</div></td>
                      <td className="small">{s.lang}</td>
                      <td className="small muted">{s.role}</td>
                      <td><Badge tone={up ? "green" : up === false ? "red" : "gray"} dot>{up ? "healthy" : up === false ? "down" : "—"}</Badge></td>
                      <td className="num">{fmtNum(mm.rps, 2)}</td>
                      <td className={`num ${mm.errorRate > 0.01 ? "bad" : ""}`}>{fmtPct(mm.errorRate, 2)}</td>
                      <td className="num">{fmtMs(mm.p99Ms)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
        <Card className="c-4" title="Circuit breakers" icon={CircuitBoard} hint="live">
          {(breakers.data?.breakers || []).map((b) => (
            <div key={b.service + b.dependency} className="breaker">
              <span className={`dot ${b.state === "closed" ? "green" : b.state === "open" ? "red" : "amber"}`} />
              <span className="small grow">{b.service} <span className="dim">→</span> {b.dependency}</span>
              <Badge value={b.state} />
            </div>
          ))}
          {!(breakers.data?.breakers || []).length && <Empty>No breaker metrics yet.</Empty>}
          <div className="tiny dim mt">Opens after 5 consecutive failures, probes again after 15 s (half-open), closes on success.</div>
        </Card>
      </div>
    </div>
  );
}
