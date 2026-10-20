import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Bug, CheckCircle2, History, ListChecks, Play, PlayCircle, ShieldCheck, ShieldQuestion, Wrench, XCircle } from "lucide-react";
import { useLive } from "../components/Layout";
import { Badge, Card, ChartTooltip, Empty, Gauge, toast } from "../components/ui";
import { api } from "../lib/api";
import { atkInfo } from "../lib/catalog";
import { usePoll } from "../lib/hooks";
import { fmtDateTime, timeAgo } from "../lib/format";

export default function SecurityLab() {
  const { security, refreshSecurity } = useLive();
  const attacks = usePoll("/security/attacks", 60000);
  const runs = usePoll("/security/runs", 4000);
  const posture = usePoll("/security/posture", 4000);
  const [selected, setSelected] = useState(null);
  const [sweep, setSweep] = useState(null); // {done, total, current}

  const list = attacks.data || [];
  const allRuns = useMemo(() => [...(runs.data || [])].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)), [runs.data]);
  const latest = posture.data?.latest || {};
  const shown = (selected && allRuns.find((r) => r.runId === selected)) || allRuns[0];

  async function runOne(id) {
    const r = await api(`/security/attacks/${id}/run`, { method: "POST", timeoutMs: 180000 });
    return r;
  }

  async function run(id) {
    toast("Attack started", atkInfo(id).name);
    try {
      const r = await runOne(id);
      if (r?.verdict) toast(`${atkInfo(id).name}: ${r.verdict}`, null, r.verdict === "defended" ? "success" : "error");
      if (r?.runId) setSelected(r.runId);
    } catch (e) {
      toast("Attack failed to run", e.message, "error");
    } finally {
      runs.refresh(); posture.refresh(); refreshSecurity();
    }
  }

  async function runAll() {
    setSweep({ done: 0, total: list.length, current: null });
    for (let i = 0; i < list.length; i++) {
      setSweep({ done: i, total: list.length, current: list[i].id });
      try { await runOne(list[i].id); } catch (e) { toast(`${atkInfo(list[i].id).name} failed to run`, e.message, "error"); }
      runs.refresh(); posture.refresh();
    }
    setSweep(null);
    setSelected(null);
    toast("Full security sweep complete", "Posture score updated", "success");
  }

  const chart = list.map((a) => {
    const r = latest[a.id];
    const f = r?.findings || [];
    return { code: atkInfo(a.id).name.split(" ")[0], name: atkInfo(a.id).name, passed: f.filter((x) => x.passed).length, failed: f.filter((x) => !x.passed).length };
  });

  return (
    <div className="stack">
      <div className="grid">
        <Card className="c-4" title="Security posture" icon={ShieldCheck}>
          <Gauge value={posture.data?.score} label="defended" size={160} />
          <div className="grid mt center" style={{ gap: 8 }}>
            <div className="c-4"><b className="good" style={{ fontSize: 20 }}>{posture.data?.defended ?? 0}</b><div className="tiny dim">defended</div></div>
            <div className="c-4"><b className="bad" style={{ fontSize: 20 }}>{posture.data?.vulnerableOrPartial ?? 0}</b><div className="tiny dim">weak</div></div>
            <div className="c-4"><b style={{ fontSize: 20 }}>{posture.data?.attacksEvaluated ?? 0}/6</b><div className="tiny dim">evaluated</div></div>
          </div>
          <button className="btn primary block lg mt" disabled={!!sweep || !!security?.activeRun || !list.length} onClick={runAll}>
            <PlayCircle size={17} />{sweep ? `Running ${sweep.done + 1}/${sweep.total}…` : "Run full security sweep"}
          </button>
          {sweep && <div className="progress mt-sm"><div style={{ width: `${((sweep.done + 0.5) / sweep.total) * 100}%` }} /></div>}
          {sweep?.current && <div className="tiny muted mt-sm center">{atkInfo(sweep.current).name}</div>}
          <div className="tiny dim mt">Authorized self-testing only: every attack's targets are hard-coded to RideFlow's own services.</div>
        </Card>

        <Card className="c-8" title="Findings by attack" icon={ListChecks} hint="latest run of each attack">
          {chart.some((c) => c.passed + c.failed > 0) ? (
            <ResponsiveContainer width="100%" height={290}>
              <BarChart data={chart} layout="vertical" margin={{ top: 4, right: 10, left: 20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 4" horizontal={false} />
                <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="name" width={170} tickLine={false} axisLine={false} />
                <Tooltip cursor={{ fill: "rgba(91,140,255,0.06)" }} content={<ChartTooltip />} />
                <Legend iconType="circle" iconSize={8} />
                <Bar dataKey="passed" name="Checks defended" stackId="a" fill="#34d399" radius={[0, 0, 0, 0]} />
                <Bar dataKey="failed" name="Checks failed" stackId="a" fill="#f87171" radius={[0, 6, 6, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty>Run the full sweep to populate this chart.</Empty>}
        </Card>
      </div>

      <Card title="Attack catalogue" icon={Bug} hint="mapped to OWASP Top 10 / API Top 10 · defined in attacks/*.yaml">
        <div className="tile-grid">
          {list.map((a) => {
            const info = atkInfo(a.id);
            const last = latest[a.id];
            return (
              <div key={a.id} className="tile">
                <div className="row between"><Badge tone="violet">{info.category}</Badge>{last ? <Badge value={last.verdict} dot /> : <Badge tone="gray">not run</Badge>}</div>
                <div className="title">{info.name}</div>
                <div className="meta"><Badge value={a.severity_if_vulnerable}>{a.severity_if_vulnerable} if vulnerable</Badge><Badge tone="gray">{a.target_service}</Badge></div>
                <div className="small muted">{info.what}</div>
                <div className="tiny dim">{info.owasp}</div>
                <div className="small" style={{ display: "flex", gap: 6 }}><Wrench size={13} style={{ flexShrink: 0, marginTop: 2, color: "var(--cyan)" }} /><span className="muted">{info.fix}</span></div>
                <div className="foot">
                  <button className="btn primary sm" disabled={!!sweep || !!security?.activeRun} onClick={() => run(a.id)}><Play size={13} />Run attack</button>
                  {last && <span className="tiny dim">{timeAgo(last.startedAt)}</span>}
                </div>
              </div>
            );
          })}
        </div>
        {!list.length && <Empty>Loading attacks…</Empty>}
      </Card>

      <div className="grid">
        <Card className="c-7" title={shown ? `Findings: ${atkInfo(shown.attackId).name}` : "Findings"} icon={ShieldQuestion}
          actions={shown && <Badge value={shown.verdict} dot />}>
          {shown ? (
            <>
              <div className="tiny dim mb">{fmtDateTime(shown.startedAt)} · {(shown.findings || []).length} checks</div>
              {(shown.findings || []).map((f, i) => (
                <div key={i} className="finding">
                  {f.passed ? <CheckCircle2 size={18} className="good" style={{ flexShrink: 0 }} /> : <XCircle size={18} className="bad" style={{ flexShrink: 0 }} />}
                  <div>
                    <div className="small" style={{ fontWeight: 600 }}>{f.check.replace(/_/g, " ")} <Badge tone={f.passed ? "green" : "red"}>{f.passed ? "defended" : "weakness"}</Badge></div>
                    <div className="small muted mt-sm">{f.detail}</div>
                    {f.evidence && <div className="ev">{typeof f.evidence === "string" ? f.evidence : JSON.stringify(f.evidence)}</div>}
                  </div>
                </div>
              ))}
              {!f_has(shown) && <Empty>No findings recorded.</Empty>}
            </>
          ) : <Empty>Run an attack to see its findings.</Empty>}
        </Card>
        <Card className="c-5" title="Attack history" icon={History}>
          <div className="table-wrap" style={{ maxHeight: 460, overflowY: "auto" }}>
            <table className="table">
              <thead><tr><th>Attack</th><th>Verdict</th><th className="num">Failed</th><th>When</th></tr></thead>
              <tbody>
                {allRuns.map((r) => (
                  <tr key={r.runId} className={`clickable ${shown?.runId === r.runId ? "selected" : ""}`} onClick={() => setSelected(r.runId)}>
                    <td className="small">{atkInfo(r.attackId).name}</td>
                    <td><Badge value={r.verdict} /></td>
                    <td className="num">{(r.findings || []).filter((f) => !f.passed).length}/{(r.findings || []).length}</td>
                    <td className="small muted">{timeAgo(r.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!allRuns.length && <Empty>No attacks run yet.</Empty>}
          </div>
        </Card>
      </div>
    </div>
  );
}

const f_has = (r) => (r.findings || []).length > 0;
