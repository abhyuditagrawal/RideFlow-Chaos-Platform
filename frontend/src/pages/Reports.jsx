import { useMemo, useState } from "react";
import { Award, Download, FileJson, FileSpreadsheet, Printer, ShieldCheck, Trash2, Zap } from "lucide-react";
import { useLive } from "../components/Layout";
import { Badge, Card, Empty, Gauge, toast } from "../components/ui";
import { api } from "../lib/api";
import { atkInfo, EXPERIMENTS, expInfo } from "../lib/catalog";
import { usePoll } from "../lib/hooks";
import { downloadFile, fmtDateTime, fmtSecs, mean, toCsv } from "../lib/format";

export default function Reports() {
  const { chaos } = useLive();
  const [clearing, setClearing] = useState(false);
  // zone/region experiments can't mean anything on a single Docker host
  const notApplicable = (id) => chaos?.backend === "LocalBackend" && !!EXPERIMENTS[id]?.localNote && /AZ|region|availability zone|two-region|multi-AZ/i.test(EXPERIMENTS[id].localNote);
  const exps = usePoll("/chaos/experiments", 60000);
  const runs = usePoll("/chaos/runs", 10000);
  const secRuns = usePoll("/security/runs", 10000);
  const posture = usePoll("/security/posture", 10000);

  const realRuns = useMemo(() => (runs.data || []).filter((r) => !r.dryRun && r.status !== "running"), [runs.data]);
  const rows = useMemo(() => [...(exps.data || [])].sort((a, b) => (expInfo(a.id).code || a.id).localeCompare(expInfo(b.id).code || b.id, undefined, { numeric: true })).map((e) => {
    const rs = realRuns.filter((r) => r.experimentId === e.id);
    const pass = rs.filter((r) => r.result === "pass").length;
    return {
      code: expInfo(e.id).code, id: e.id, name: expInfo(e.id).name, hypothesis: e.hypothesis || "",
      runs: rs.length, required: e.runs_required || 1, pass,
      passRate: rs.length ? pass / rs.length : null,
      mttd: mean(rs.map((r) => r.mttdSeconds).filter((x) => x != null)),
      mttr: mean(rs.map((r) => r.mttrSeconds).filter((x) => x != null)),
      noImpact: rs.filter((r) => r.status === "pass" && r.mttdSeconds == null).length,
      na: notApplicable(e.id),
    };
  }), [exps.data, realRuns, chaos?.backend]); // eslint-disable-line react-hooks/exhaustive-deps

  const tested = rows.filter((r) => r.runs > 0 && !r.na);
  const resilience = tested.length ? Math.round((tested.reduce((a, r) => a + r.passRate, 0) / tested.length) * 100) : null;
  const sec = posture.data;
  const overall = resilience != null && sec?.score != null ? Math.round((resilience + sec.score) / 2) : resilience ?? sec?.score ?? null;
  const grade = overall == null ? "—" : overall >= 90 ? "A" : overall >= 75 ? "B" : overall >= 60 ? "C" : overall >= 40 ? "D" : "E";

  function exportJson() {
    downloadFile(`rideflow-report-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({
      generatedAt: new Date().toISOString(), resilienceScore: resilience, securityScore: sec?.score ?? null, overall,
      experiments: rows, chaosRuns: runs.data || [], securityPosture: sec || null, securityRuns: secRuns.data || [],
    }, null, 2));
  }
  function exportCsv() {
    downloadFile(`rideflow-chaos-runs-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(realRuns.map((r) => ({
      experiment: r.experimentId, code: expInfo(r.experimentId).code, result: r.result, status: r.status,
      started: r.t0 ? new Date(r.t0 * 1000).toISOString() : "", mttd_s: r.mttdSeconds ?? "", mttr_s: r.mttrSeconds ?? "",
    }))), "text/csv");
  }

  async function clearHistory() {
    if (!window.confirm("Delete all finished chaos and security runs? Use this to start a clean demo. This can't be undone.")) return;
    setClearing(true);
    try {
      const [c, s] = await Promise.all([api("/chaos/runs", { method: "DELETE" }), api("/security/runs", { method: "DELETE" })]);
      toast("History cleared", `${c.removed} chaos runs and ${s.removed} security runs removed`, "success");
      runs.refresh(); secRuns.refresh(); posture.refresh();
    } catch (e) {
      toast("Could not clear history", e.message, "error");
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="stack">
      <div className="row between no-print">
        <span className="muted small">Generated live from the chaos and security engines' run history.</span>
        <div className="row">
          <button className="btn" onClick={clearHistory} disabled={clearing}><Trash2 size={15} />Clear history</button>
          <button className="btn" onClick={exportCsv}><FileSpreadsheet size={15} />Chaos runs CSV</button>
          <button className="btn" onClick={exportJson}><FileJson size={15} />Full report JSON</button>
          <button className="btn primary" onClick={() => window.print()}><Printer size={15} />Print / PDF</button>
        </div>
      </div>

      <div className="grid">
        <Card className="c-4" title="Overall grade" icon={Award}>
          <div className="center">
            <div style={{ fontSize: 64, fontWeight: 900, background: "var(--grad)", WebkitBackgroundClip: "text", color: "transparent", lineHeight: 1.1 }}>{grade}</div>
            <div className="muted small">average of resilience and security scores</div>
          </div>
        </Card>
        <Card className="c-4" title="Resilience score" icon={Zap}>
          <Gauge value={resilience} label="hypotheses held" size={140} />
          <div className="tiny dim center mt-sm">{tested.length} of {rows.length} experiments run · {realRuns.length} total runs</div>
        </Card>
        <Card className="c-4" title="Security score" icon={ShieldCheck}>
          <Gauge value={sec?.score} label="attacks defended" size={140} />
          <div className="tiny dim center mt-sm">{sec?.defended ?? 0} defended · {sec?.vulnerableOrPartial ?? 0} weak</div>
        </Card>
      </div>

      <Card title="Resilience scorecard" icon={Zap} hint="one row per experiment; real runs only">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>#</th><th>Experiment</th><th>Hypothesis</th><th className="num">Runs</th><th className="num">Pass rate</th><th className="num">Avg MTTD</th><th className="num">Avg MTTR</th><th className="num">No-impact runs</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><span className="code-chip">{r.code}</span></td>
                  <td className="small"><b>{r.name}</b></td>
                  <td className="small muted" style={{ maxWidth: 320 }}>{r.hypothesis}</td>
                  <td className="num">{r.runs}<span className="dim">/{r.required}</span></td>
                  <td className="num">{r.na ? <Badge tone="gray">N/A on Docker</Badge> : r.passRate == null ? <span className="dim">not run</span> : <Badge tone={r.passRate === 1 ? "green" : r.passRate >= 0.5 ? "amber" : "red"}>{Math.round(r.passRate * 100)}%</Badge>}</td>
                  <td className="num">{fmtSecs(r.mttd)}</td>
                  <td className="num">{fmtSecs(r.mttr)}</td>
                  <td className="num">{r.runs ? r.noImpact : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <Empty>Loading…</Empty>}
        </div>
        <div className="tiny dim mt">"Runs x/y": y is the number of repetitions the experiment plan asks for (one run is an anecdote, five is data). "No impact" means the steady state never broke, so there was nothing to detect or recover from. N/A: zone and region failover need the multi-region Kubernetes deployment, so they're excluded from the score on a single Docker host.</div>
      </Card>

      <Card title="Security findings summary" icon={ShieldCheck}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Attack</th><th>OWASP</th><th>Verdict</th><th>Weaknesses found</th><th>Recommended fix</th><th>Last run</th></tr></thead>
            <tbody>
              {Object.entries(sec?.latest || {}).map(([id, r]) => (
                <tr key={id}>
                  <td className="small"><b>{atkInfo(id).name}</b></td>
                  <td className="tiny muted">{atkInfo(id).owasp}</td>
                  <td><Badge value={r.verdict} /></td>
                  <td className="small">{(r.findings || []).filter((f) => !f.passed).map((f) => f.check.replace(/_/g, " ")).join(", ") || <span className="good">none</span>}</td>
                  <td className="small muted" style={{ maxWidth: 300 }}>{atkInfo(id).fix}</td>
                  <td className="small muted">{fmtDateTime(r.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!Object.keys(sec?.latest || {}).length && <Empty>No security attacks run yet.</Empty>}
        </div>
      </Card>

      <div className="tiny dim center no-print"><Download size={12} /> Exports include every run so results can go straight into the project report.</div>
    </div>
  );
}
