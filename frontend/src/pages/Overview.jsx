import { Link } from "react-router-dom";
import { Activity, AlertOctagon, CarFront, Clock, Gauge as GaugeIcon, GitBranch, HeartPulse, Map, ShieldCheck, Zap } from "lucide-react";
import { useLive } from "../components/Layout";
import Topology, { targetOf } from "../components/Topology";
import TrafficChart from "../components/TrafficChart";
import FleetMap from "../components/FleetMap";
import SimulatorControl from "../components/SimulatorControl";
import { Badge, Card, Empty, Gauge, Kpi } from "../components/ui";
import { usePoll } from "../lib/hooks";
import { expInfo, SERVICES } from "../lib/catalog";
import { fmtMs, fmtNum, fmtPct, fmtSecs, timeAgo } from "../lib/format";

export default function Overview() {
  const { chaos, security } = useLive();
  const summary = usePoll("/chaos/metrics/summary", 3000);
  const history = usePoll("/chaos/metrics/history?minutes=15", 10000);
  const services = usePoll("/chaos/metrics/services", 5000);
  const breakers = usePoll("/chaos/breakers", 3000);
  const posture = usePoll("/security/posture", 8000);
  const fleet = usePoll("/chaos/fleet", 5000);

  const m = summary.data || {};
  const pts = history.data?.points || [];
  const health = chaos?.serviceHealth || {};
  const healthy = Object.values(health).filter(Boolean).length;
  const run = chaos?.activeRun;
  const lastRun = chaos?.recentRuns?.find((r) => r.status !== "running" && !r.dryRun);
  const openBreakers = (breakers.data?.breakers || []).filter((b) => b.state !== "closed");

  return (
    <div className="stack">
      <div className="grid">
        <div className="c-3"><Kpi label="Requests / sec" icon={Activity} value={fmtNum(m.rps, 2)} foot="api-gateway, 1 min rate" spark={pts} sparkKey="rps" color="#5b8cff" /></div>
        <div className="c-3"><Kpi label="Error rate" icon={AlertOctagon} value={fmtPct(m.errorRate)} tone={m.errorRate > 0.05 ? "bad" : m.errorRate > 0.01 ? "warn" : "good"} foot="5xx / total requests" spark={pts} sparkKey="errorRate" color="#f87171" /></div>
        <div className="c-3"><Kpi label="p99 latency" icon={Clock} value={m.p99LatencyMs == null ? "—" : Math.round(m.p99LatencyMs)} unit="ms" foot="slowest 1% of requests" spark={pts} sparkKey="p99Ms" color="#a78bfa" /></div>
        <div className="c-3"><Kpi label="Rides / min" icon={CarFront} value={fmtNum(m.ridesPerMin, 1)} foot="successfully created" spark={pts} sparkKey="ridesPerMin" color="#34d399" /></div>
      </div>

      {run && (
        <Card className="glow" title={`Experiment in progress: ${expInfo(run.experimentId).name}`} icon={Zap}
          actions={<Link className="btn primary sm" to="/chaos">Open Chaos Lab</Link>}>
          <div className="row small muted">
            <Badge value="running" dot>running</Badge>
            <span>{run.log?.[run.log.length - 1]}</span>
          </div>
        </Card>
      )}

      <div className="grid">
        <Card className="c-8" title="Live service topology" icon={GitBranch}
          hint={`${healthy}/${Object.keys(health).length || 5} services healthy`}
          actions={openBreakers.length ? <Badge tone="red" dot>{openBreakers.length} breaker(s) open</Badge> : <Badge tone="green">all breakers closed</Badge>}>
          <Topology health={health} breakers={breakers.data?.breakers || []} target={targetOf(run?.experimentId)} trafficOn={chaos?.simulator?.running} />
          <div className="row tiny dim center" style={{ justifyContent: "center" }}>
            <span><span className="dot green" /> healthy</span><span><span className="dot red" /> down / breaker open</span><span><span className="dot amber" /> fault target</span><span>moving dashes = live traffic</span>
          </div>
        </Card>
        <div className="c-4 stack">
          <Card title="Security posture" icon={ShieldCheck} actions={<Link to="/security" className="btn sm">Details</Link>}>
            <div className="row" style={{ alignItems: "center", gap: 18 }}>
              <Gauge value={posture.data?.score} label="defended" size={120} />
              <div className="col small">
                <span><b className="good">{posture.data?.defended ?? 0}</b> defended</span>
                <span><b className="bad">{posture.data?.vulnerableOrPartial ?? 0}</b> weak / partial</span>
                <span className="muted">{posture.data?.attacksEvaluated ?? 0} of 6 attack types run</span>
              </div>
            </div>
          </Card>
          <Card title="Last chaos result" icon={HeartPulse} actions={<Link to="/chaos" className="btn sm">Run one</Link>}>
            {lastRun ? (
              <>
                <div className="row between">
                  <b className="small">{expInfo(lastRun.experimentId).name}</b>
                  <Badge value={lastRun.result} />
                </div>
                <div className="grid mt-sm" style={{ gap: 8 }}>
                  <div className="c-6"><div className="dim tiny">MTTD</div><b>{lastRun.mttdSeconds != null ? fmtSecs(lastRun.mttdSeconds) : lastRun.status === "pass" ? "no impact" : "—"}</b></div>
                  <div className="c-6"><div className="dim tiny">MTTR</div><b>{lastRun.mttrSeconds != null ? fmtSecs(lastRun.mttrSeconds) : lastRun.status === "pass" ? "no impact" : "—"}</b></div>
                </div>
                <div className="tiny dim mt-sm">{timeAgo(lastRun.t0)}</div>
              </>
            ) : <Empty>No experiments run yet.</Empty>}
          </Card>
        </div>
      </div>

      <div className="grid">
        <Card className="c-8" title="Traffic & latency" icon={GaugeIcon} hint="last 15 minutes · Prometheus">
          {pts.length ? <TrafficChart points={pts} series={["ridesPerMin", "p99Ms"]} /> : <Empty>Waiting for metrics… start the traffic simulator if this stays empty.</Empty>}
        </Card>
        <div className="c-4"><SimulatorControl compact /></div>
      </div>

      <div className="grid">
        <Card className="c-7" title="Services" icon={HeartPulse} hint="RED metrics per service">
          <div className="health-grid">
            {SERVICES.map((s) => {
              const up = health[s.id];
              const mm = services.data?.services?.[s.id] || {};
              return (
                <div key={s.id} className={`svc ${up === false ? "down" : ""}`}>
                  <div className="name"><span className={`dot ${up ? "green" : up === false ? "red" : ""}`} />{s.id}</div>
                  <div className="tiny dim">{s.lang} · :{s.port}</div>
                  <div className="stats">
                    <div><b>{fmtNum(mm.rps, 1)}</b>rps</div>
                    <div><b className={mm.errorRate > 0.01 ? "bad" : ""}>{fmtPct(mm.errorRate, 1)}</b>err</div>
                    <div><b>{fmtMs(mm.p99Ms)}</b>p99</div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
        <Card className="c-5" title="Fleet" icon={Map} hint={`${fleet.data?.drivers?.length ?? 0} drivers online`} actions={<Link to="/rides" className="btn sm">Book a ride</Link>}>
          <FleetMap drivers={fleet.data?.drivers || []} className="map short" />
        </Card>
      </div>

      {security?.activeRun && (
        <Card title="Security attack running" icon={ShieldCheck}><span className="muted">{security.activeRun.attackId}</span></Card>
      )}
    </div>
  );
}
