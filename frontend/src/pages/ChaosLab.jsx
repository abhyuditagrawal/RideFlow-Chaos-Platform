import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BarChart3, CalendarClock, FlaskConical, History, OctagonX, Play, Power, ShieldAlert, Target, Timer, Zap } from "lucide-react";
import { useLive } from "../components/Layout";
import SimulatorControl from "../components/SimulatorControl";
import TrafficChart from "../components/TrafficChart";
import { Badge, Card, ChartTooltip, Empty, toast } from "../components/ui";
import { api } from "../lib/api";
import { expInfo, FAULT_LABEL } from "../lib/catalog";
import { useNow, usePoll } from "../lib/hooks";
import { fmtSecs, fmtTime, mean, timeAgo } from "../lib/format";

const parseDur = (s) => {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(String(s || "").trim());
  return m ? Number(m[1]) * ({ s: 1, m: 60, h: 3600 }[m[2] || "s"]) : 120;
};
const targetLabel = (exp) => exp.fault.selector.labelSelector?.replace("app=", "") || (exp.fault.selector.zone ? `zone ${exp.fault.selector.zone}` : "primary region");

function phasesOf(run) {
  const log = (run.log || []).join("\n");
  const finished = run.status !== "running";
  const aborted = run.status === "aborted";
  const p = [
    { k: "Validate", done: !!run.t0 || log.includes("[dry-run]") || finished },
    { k: "Inject", done: !!run.t0 },
    { k: "Detect", done: !!run.tDetect || log.includes("NO IMPACT") || log.includes("REVERT"), note: run.mttdSeconds != null ? fmtSecs(run.mttdSeconds) : null },
    { k: "Revert", done: log.includes("REVERT") },
    { k: "Recover", done: !!run.tRecover || log.includes("NO IMPACT") || log.includes("RECOVERED"), note: run.mttrSeconds != null ? fmtSecs(run.mttrSeconds) : null },
    { k: "Report", done: finished },
  ];
  const nowIdx = finished ? -1 : p.findIndex((x) => !x.done);
  return p.map((x, i) => ({ ...x, state: x.done ? "done" : i === nowIdx ? "now" : aborted && i === p.findIndex((y) => !y.done) ? "fail" : "" }));
}

function RunTracker({ run, exp }) {
  const now = useNow();
  const history = usePoll("/chaos/metrics/history?minutes=5", 5000, { enabled: !!run });
  if (!run) return null;
  const dur = exp ? parseDur(exp.duration) : 120;
  const elapsed = run.t0 ? now - run.t0 : 0;
  const pct = run.status === "running" ? Math.min(97, (elapsed / (dur + 35)) * 100) : 100;
  const steps = phasesOf(run);
  const info = expInfo(run.experimentId);
  return (
    <Card className={run.status === "running" ? "glow" : ""} title={run.status === "running" ? "Experiment running" : "Last experiment"} icon={Timer}
      actions={<Badge value={run.status === "running" ? "running" : run.result} dot />}>
      <div className="row between">
        <div>
          <div style={{ fontWeight: 700, fontSize: 16 }}><span className="code-chip">{info.code}</span> {info.name}</div>
          <div className="small muted mt-sm">{exp?.hypothesis ? <>Hypothesis: <i>{exp.hypothesis}</i></> : info.expect}</div>
        </div>
        <div className="row">
          <div className="center"><div className="dim tiny">{run.status === "running" ? "Elapsed" : "Fault window"}</div><b>{run.status === "running" ? (run.t0 ? fmtSecs(elapsed) : "starting") : run.t0 ? fmtSecs(dur) : "not started"}</b></div>
          <div className="center"><div className="dim tiny">MTTD</div><b>{run.mttdSeconds != null ? fmtSecs(run.mttdSeconds) : run.status === "pass" ? "no impact" : "—"}</b></div>
          <div className="center"><div className="dim tiny">MTTR</div><b>{run.mttrSeconds != null ? fmtSecs(run.mttrSeconds) : run.status === "pass" ? "no impact" : "—"}</b></div>
        </div>
      </div>
      <div className="progress mt"><div style={{ width: `${pct}%` }} /></div>
      <div className="steps mt">
        {steps.map((s, i) => (
          <div key={s.k} className={`step ${s.state}`}><div className="bubble">{s.state === "done" ? "✓" : i + 1}</div>{s.k}{s.note && <div className="tiny">{s.note}</div>}</div>
        ))}
      </div>
      <div className="grid mt">
        <div className="c-6">
          <div className="tiny dim mb">Engine log</div>
          <div className="log">
            {(run.log || []).map((l, i) => <div key={i} className={`line ${/ABORT|ERROR|NOT recover/.test(l) ? "err" : ""}`}>{l}</div>)}
          </div>
        </div>
        <div className="c-6">
          <div className="tiny dim mb">Gateway during the run (last 5 min)</div>
          {history.data?.points?.length ? <TrafficChart points={history.data.points} height={210} series={["errorRate", "p99Ms"]} /> : <Empty>Loading metrics…</Empty>}
        </div>
      </div>
    </Card>
  );
}

function SafetyControls({ chaos, refresh }) {
  const [interval, setIntervalS] = useState(600);
  const sched = chaos?.schedule;
  async function call(path, method, msg) {
    try { await api(path, { method }); toast(msg); refresh(); } catch (e) { toast("Failed", e.message, "error"); }
  }
  return (
    <Card title="Safety & automation" icon={ShieldAlert}>
      <button className="btn danger block lg" onClick={() => call("/chaos/abort", "POST", "Emergency abort sent. All active faults reverted")}>
        <OctagonX size={17} />EMERGENCY ABORT
      </button>
      <div className="tiny dim mt-sm">Reverts every active fault immediately and stops the current run.</div>
      <div className="divider" />
      <div className="row between">
        <div><b className="small">Chaos kill switch</b><div className="tiny dim">When off, no experiment can start.</div></div>
        <button className={`btn sm ${chaos?.enabled ? "" : "success"}`} onClick={() => call(`/chaos/kill-switch?enabled=${!chaos?.enabled}`, "POST", chaos?.enabled ? "Chaos disabled" : "Chaos re-enabled")}>
          <Power size={14} />{chaos?.enabled ? "Disable" : "Enable"}
        </button>
      </div>
      <div className="divider" />
      <div><b className="small">Game day scheduler</b><div className="tiny dim">Runs a random experiment on a timer, like Netflix's Chaos Monkey.</div></div>
      <div className="row mt-sm">
        <select className="input grow" value={interval} onChange={(e) => setIntervalS(Number(e.target.value))}>
          <option value={300}>every 5 minutes</option><option value={600}>every 10 minutes</option><option value={1800}>every 30 minutes</option>
        </select>
        {sched?.enabled
          ? <button className="btn sm" onClick={() => call("/chaos/schedule", "DELETE", "Game day stopped")}>Stop</button>
          : <button className="btn sm primary" onClick={() => call(`/chaos/schedule?interval_seconds=${interval}`, "POST", "Game day scheduled")}><CalendarClock size={14} />Start</button>}
      </div>
      {sched?.enabled && <div className="tiny muted mt-sm">Active: every {Math.round(sched.intervalSeconds / 60)} min · next at {fmtTime(sched.nextRunAt)}</div>}
    </Card>
  );
}

export default function ChaosLab() {
  const { chaos, refreshChaos } = useLive();
  const exps = usePoll("/chaos/experiments", 60000);
  const runs = usePoll("/chaos/runs", 4000);
  const [dry, setDry] = useState(false);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(null);

  const experiments = useMemo(() => [...(exps.data || [])].sort((a, b) => (expInfo(a.id).code || a.id).localeCompare(expInfo(b.id).code || b.id, undefined, { numeric: true })), [exps.data]);
  const allRuns = runs.data || [];
  const active = chaos?.activeRun;
  const shown = active || (selected && allRuns.find((r) => r.runId === selected)) || allRuns.find((r) => !r.dryRun) || null;
  const expById = useMemo(() => Object.fromEntries(experiments.map((e) => [e.id, e])), [experiments]);

  async function run(id, dryRun) {
    if (!chaos?.simulator?.running && !dryRun) {
      toast("Traffic is off", "Start the traffic simulator first. Without traffic there is nothing to measure.", "error");
      return;
    }
    setSelected(null);
    toast(dryRun ? "Dry run started" : "Experiment started", expInfo(id).name);
    try {
      // blocks until the run ends when talking straight to the injector; on
      // Vercel the proxy answers 202 after ~20 s. Status polling shows progress.
      await api(`/chaos/experiments/${id}/run?dryRun=${dryRun}`, { method: "POST", timeoutMs: 600000 });
    } catch (e) {
      if (e.code !== "network") toast("Could not run experiment", e.message, "error");
    } finally {
      refreshChaos();
      runs.refresh();
    }
  }

  const stats = useMemo(() => {
    const by = {};
    allRuns.filter((r) => !r.dryRun && r.status !== "running").forEach((r) => {
      (by[r.experimentId] ||= []).push(r);
    });
    return Object.entries(by).map(([id, rs]) => ({
      id, code: expInfo(id).code || id,
      runs: rs.length,
      pass: rs.filter((r) => r.result === "pass").length,
      mttd: mean(rs.map((r) => r.mttdSeconds).filter((x) => x != null)),
      mttr: mean(rs.map((r) => r.mttrSeconds).filter((x) => x != null)),
    })).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  }, [allRuns]);

  const filtered = allRuns.filter((r) => filter === "all" || (filter === "real" ? !r.dryRun : r.experimentId === filter));

  return (
    <div className="stack">
      <div className="grid">
        <div className="c-8">
          {shown ? <RunTracker run={shown} exp={expById[shown.experimentId]} /> : (
            <Card title="No experiment yet" icon={FlaskConical}>
              <p className="desc">Pick an experiment below. Every run follows the same lifecycle: validate the steady state, inject the fault, detect the breach (MTTD), revert, measure recovery (MTTR), report pass or fail against the hypothesis.</p>
            </Card>
          )}
        </div>
        <div className="c-4 stack">
          <SafetyControls chaos={chaos} refresh={refreshChaos} />
        </div>
      </div>

      <div className="grid">
        <div className="c-8">
          <Card title="Experiment catalogue" icon={Zap} hint={`${experiments.length} experiments · defined in experiments/*.yaml`}
            actions={<label className="check"><input type="checkbox" checked={dry} onChange={(e) => setDry(e.target.checked)} />Dry run</label>}>
            <div className="tile-grid">
              {experiments.map((e) => {
                const info = expInfo(e.id);
                const last = allRuns.find((r) => r.experimentId === e.id && !r.dryRun && r.status !== "running");
                return (
                  <div key={e.id} className={`tile ${active?.experimentId === e.id ? "selected" : ""}`}>
                    <div className="row between"><span className="code-chip">{info.code}</span>{last && <Badge value={last.result} />}</div>
                    <div className="title">{info.name}</div>
                    <div className="meta">
                      <Badge tone="violet">{FAULT_LABEL[e.fault.type]}</Badge>
                      <Badge tone="gray"><Target size={11} />{targetLabel(e)}</Badge>
                      <Badge tone="gray"><Timer size={11} />{e.duration}</Badge>
                    </div>
                    <div className="small muted">{e.hypothesis || info.expect}</div>
                    <div className="tiny dim">{info.layer}</div>
                    {info.localNote && chaos?.backend === "LocalBackend" && <div className="tiny warn">{info.localNote}</div>}
                    <div className="foot">
                      <button className="btn primary sm" disabled={!!active || !chaos?.enabled} onClick={() => run(e.id, dry)}><Play size={13} />{dry ? "Dry run" : "Run"}</button>
                      {last && <span className="tiny dim">last: {timeAgo(last.t0)}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
            {!experiments.length && <Empty>Loading experiments…</Empty>}
          </Card>
        </div>
        <div className="c-4"><SimulatorControl /></div>
      </div>

      <div className="grid">
        <Card className="c-5" title="Mean time to detect / recover" icon={BarChart3} hint="averaged over real runs">
          {stats.some((s) => s.mttd != null || s.mttr != null) ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={stats} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 4" vertical={false} />
                <XAxis dataKey="code" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} unit="s" />
                <Tooltip cursor={{ fill: "rgba(91,140,255,0.06)" }} content={<ChartTooltip formatters={{ mttd: fmtSecs, mttr: fmtSecs }} />} />
                <Legend iconType="circle" iconSize={8} />
                <Bar dataKey="mttd" name="MTTD" fill="#fbbf24" radius={[6, 6, 0, 0]} />
                <Bar dataKey="mttr" name="MTTR" fill="#5b8cff" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty>Run an experiment that causes impact (e.g. E1) to see MTTD/MTTR here. "No impact" runs have nothing to measure.</Empty>}
          <div className="table-wrap mt">
            <table className="table">
              <thead><tr><th>Exp</th><th className="num">Runs</th><th className="num">Pass</th><th className="num">MTTD</th><th className="num">MTTR</th></tr></thead>
              <tbody>{stats.map((s) => (
                <tr key={s.id}><td><span className="code-chip">{s.code}</span></td><td className="num">{s.runs}</td><td className="num">{Math.round((s.pass / s.runs) * 100)}%</td><td className="num">{fmtSecs(s.mttd)}</td><td className="num">{fmtSecs(s.mttr)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </Card>
        <Card className="c-7" title="Run history" icon={History} hint="click a row to inspect it"
          actions={
            <select className="input" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ height: 30 }}>
              <option value="all">All runs</option><option value="real">Real runs only</option>
              {experiments.map((e) => <option key={e.id} value={e.id}>{expInfo(e.id).code} {expInfo(e.id).name}</option>)}
            </select>}>
          <div className="table-wrap" style={{ maxHeight: 420, overflowY: "auto" }}>
            <table className="table">
              <thead><tr><th>Experiment</th><th>Result</th><th className="num">MTTD</th><th className="num">MTTR</th><th>Started</th></tr></thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.runId} className={`clickable ${shown?.runId === r.runId ? "selected" : ""}`} onClick={() => setSelected(r.runId)}>
                    <td><span className="code-chip">{expInfo(r.experimentId).code}</span> <span className="small">{expInfo(r.experimentId).name}</span>{r.dryRun && <Badge tone="gray">dry</Badge>}</td>
                    <td><Badge value={r.status === "running" ? "running" : r.status === "aborted" ? "aborted" : r.result} /></td>
                    <td className="num">{r.mttdSeconds != null ? fmtSecs(r.mttdSeconds) : r.status === "pass" && !r.dryRun ? "no impact" : "—"}</td>
                    <td className="num">{r.mttrSeconds != null ? fmtSecs(r.mttrSeconds) : r.status === "pass" && !r.dryRun ? "no impact" : "—"}</td>
                    <td className="small muted">{r.t0 ? timeAgo(r.t0) : "not started"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!filtered.length && <Empty>No runs yet.</Empty>}
          </div>
        </Card>
      </div>
    </div>
  );
}
