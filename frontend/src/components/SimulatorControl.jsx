import { useEffect, useState } from "react";
import { Play, Radio, Square } from "lucide-react";
import { api } from "../lib/api";
import { fmtMs, fmtPct } from "../lib/format";
import { useLive } from "./Layout";
import { Badge, Card, toast } from "./ui";

export default function SimulatorControl({ compact }) {
  const { chaos, refreshChaos } = useLive();
  const sim = chaos?.simulator;
  const [rps, setRps] = useState(4);
  const [drivers, setDrivers] = useState(30);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (sim && !busy) { setRps(sim.rps); setDrivers(sim.driverCount); }
  }, [sim?.running]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(path, msg) {
    setBusy(true);
    try {
      await api(path, { method: "POST" });
      toast(msg);
      refreshChaos();
    } catch (e) {
      toast("Simulator error", e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  const s = sim?.stats || {};
  return (
    <Card title="Traffic simulator" icon={Radio} hint="riders + driver fleet"
      actions={<Badge tone={sim?.running ? "green" : "gray"} dot>{sim?.running ? "running" : "stopped"}</Badge>}>
      {!compact && <p className="desc" style={{ marginTop: 0 }}>Experiments compare live metrics against a steady state, so they need real traffic. The simulator books rides through the API gateway and keeps a fleet of drivers moving around Mumbai.</p>}
      <div className="grid" style={{ gap: 14 }}>
        <label className="field c-6">Ride requests / second: <b style={{ color: "var(--text)" }}>{rps}</b>
          <input type="range" min="0.5" max="15" step="0.5" value={rps} onChange={(e) => setRps(Number(e.target.value))} />
        </label>
        <label className="field c-6">Drivers on the road: <b style={{ color: "var(--text)" }}>{drivers}</b>
          <input type="range" min="5" max="120" step="5" value={drivers} onChange={(e) => setDrivers(Number(e.target.value))} />
        </label>
      </div>
      <div className="row mt">
        <button className="btn success" disabled={busy} onClick={() => act(`/chaos/simulator/start?rps=${rps}&drivers=${drivers}`, `Traffic running at ${rps} rps`)}>
          <Play size={15} />{sim?.running ? "Apply" : "Start traffic"}
        </button>
        <button className="btn" disabled={busy || !sim?.running} onClick={() => act("/chaos/simulator/stop", "Traffic stopped")}><Square size={14} />Stop</button>
      </div>
      {sim?.running && (
        <div className="kv mt small">
          <dt>Requests sent</dt><dd>{s.sent} <span className="dim">({s.errors} errors)</span></dd>
          <dt>Rides matched</dt><dd className="good">{s.matched}</dd>
          <dt>Waiting for driver</dt><dd className="warn">{s.pending}</dd>
          <dt>Fallback fares</dt><dd>{s.fareEstimated}</dd>
          <dt>Last 30 s</dt><dd>{fmtPct(sim.last30s?.successRate, 1)} ok · p50 {fmtMs(sim.last30s?.p50Ms)} · p95 {fmtMs(sim.last30s?.p95Ms)}</dd>
        </div>
      )}
    </Card>
  );
}
