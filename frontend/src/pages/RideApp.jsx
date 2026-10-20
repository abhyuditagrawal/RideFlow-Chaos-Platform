import { useMemo, useState } from "react";
import { Car, LogIn, LogOut, MapPin, Navigation, UserPlus, Users, X } from "lucide-react";
import FleetMap from "../components/FleetMap";
import { Badge, Card, Empty, toast } from "../components/ui";
import { api } from "../lib/api";
import { PLACES } from "../lib/catalog";
import { useLocalState, usePoll } from "../lib/hooks";
import { fmtInr, fmtNum, timeAgo } from "../lib/format";

function haversineKm(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function Account({ session, setSession }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "register") {
        await api("/app/v1/users", { method: "POST", body: { email, password } });
        toast("Account created", "Logging you in…", "success");
      }
      const { token } = await api("/app/v1/auth/login", { method: "POST", body: { email, password } });
      const me = await api("/app/v1/users/me", { appToken: token });
      setSession({ token, ...me });
      toast("Signed in", me.email, "success");
    } catch (err) {
      toast(mode === "register" ? "Sign-up failed" : "Login failed", err.message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (session) {
    return (
      <Card title="Rider account" icon={Users} actions={<button className="btn sm" onClick={() => setSession(null)}><LogOut size={14} />Sign out</button>}>
        <div className="kv small">
          <dt>Email</dt><dd>{session.email}</dd>
          <dt>Tier</dt><dd><Badge tone="violet">{session.tier}</Badge></dd>
          <dt>User ID</dt><dd className="mono tiny">{session.userId}</dd>
          <dt>Auth</dt><dd className="small muted">JWT from user-service, verified on <code>/v1/users/me</code></dd>
        </div>
      </Card>
    );
  }
  return (
    <Card title="Rider account" icon={Users} actions={
      <div className="seg">
        <button className={mode === "login" ? "on" : ""} onClick={() => setMode("login")}>Log in</button>
        <button className={mode === "register" ? "on" : ""} onClick={() => setMode("register")}>Sign up</button>
      </div>}>
      <form className="col" onSubmit={submit}>
        <input className="input" type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input" type="password" required minLength={6} placeholder="Password (6+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="btn primary" disabled={busy}>{mode === "login" ? <><LogIn size={15} />Log in</> : <><UserPlus size={15} />Create account</>}</button>
        <span className="tiny dim">Passwords are bcrypt-hashed by user-service. You can also book as a guest.</span>
      </form>
    </Card>
  );
}

export default function RideApp() {
  const [session, setSession] = useLocalState("rideflow-app-session", null);
  const [guestId] = useLocalState("rideflow-guest-id", "guest-" + Math.random().toString(36).slice(2, 8));
  const userId = session?.userId || guestId;

  const [pickup, setPickup] = useState(PLACES[5]);
  const [drop, setDrop] = useState(PLACES[7]);
  const [picking, setPicking] = useState(null); // "pickup" | "drop" | null
  const [busy, setBusy] = useState(false);

  const fleet = usePoll("/chaos/fleet", 4000);
  const mine = usePoll(`/app/v1/rides?userId=${encodeURIComponent(userId)}&limit=8`, 2500);
  const recent = usePoll("/app/v1/rides?limit=40", 4000);
  const nearby = usePoll(`/app/v1/drivers/nearby?lat=${pickup.lat}&lng=${pickup.lng}&radius=3`, 5000);

  const myRides = mine.data?.rides || [];
  const active = myRides.find((r) => r.state === "MATCHED" || r.state === "PENDING_MATCH");
  const dist = haversineKm(pickup, drop);
  const marks = useMemo(() => ({ pickup, drop }), [pickup, drop]);

  function pickOnMap(latlng) {
    if (!picking) return;
    const p = { name: `Pinned ${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`, lat: latlng.lat, lng: latlng.lng };
    picking === "pickup" ? setPickup(p) : setDrop(p);
    setPicking(null);
  }

  async function book() {
    setBusy(true);
    try {
      const ride = await api("/app/v1/rides", { method: "POST", body: { userId, pickup: { lat: pickup.lat, lng: pickup.lng }, drop: { lat: drop.lat, lng: drop.lng } } });
      toast(ride.state === "MATCHED" ? `Driver ${ride.driverId} is on the way` : "Looking for a driver…",
        `${fmtInr(ride.fare)}${ride.fareEstimated ? " (fallback fare — pricing unavailable)" : ""}`, "success");
      mine.refresh();
    } catch (e) {
      toast("Booking failed", e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id) {
    try {
      await api(`/app/v1/rides/${id}/cancel`, { method: "POST" });
      toast("Ride cancelled");
      mine.refresh();
    } catch (e) {
      toast("Cancel failed", e.message, "error");
    }
  }

  const placeSelect = (value, set) => (
    <select className="input" value={PLACES.some((p) => p.name === value.name) ? value.name : ""} onChange={(e) => set(PLACES.find((p) => p.name === e.target.value))}>
      {!PLACES.some((p) => p.name === value.name) && <option value="">{value.name}</option>}
      {PLACES.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
    </select>
  );

  return (
    <div className="grid">
      <div className="c-4 stack">
        <Card title="Book a ride" icon={Car}>
          <div className="col gap-lg">
            <label className="field"><span className="row"><span className="dot green" />Pickup</span>
              <div className="row" style={{ flexWrap: "nowrap" }}>{placeSelect(pickup, setPickup)}
                <button className={`btn sm ${picking === "pickup" ? "primary" : ""}`} onClick={() => setPicking(picking === "pickup" ? null : "pickup")} title="Pick on map"><MapPin size={14} /></button></div>
            </label>
            <label className="field"><span className="row"><span className="dot" style={{ background: "var(--pink)" }} />Drop</span>
              <div className="row" style={{ flexWrap: "nowrap" }}>{placeSelect(drop, setDrop)}
                <button className={`btn sm ${picking === "drop" ? "primary" : ""}`} onClick={() => setPicking(picking === "drop" ? null : "drop")} title="Pick on map"><MapPin size={14} /></button></div>
            </label>
            {picking && <div className="badge blue">Click on the map to set the {picking}</div>}
            <div className="kv small">
              <dt>Distance</dt><dd>{fmtNum(dist, 1)} km</dd>
              <dt>Drivers within 3 km</dt><dd>{nearby.data?.drivers?.length ?? "—"}</dd>
              <dt>Booking as</dt><dd>{session ? session.email : <span className="muted">{guestId} (guest)</span>}</dd>
            </div>
            <button className="btn primary lg block" onClick={book} disabled={busy || dist < 0.2}><Navigation size={16} />{busy ? "Booking…" : "Request ride"}</button>
          </div>
        </Card>
        <Account session={session} setSession={setSession} />
      </div>

      <div className="c-8 stack">
        <Card title="Live city map" icon={MapPin} hint="drivers (cyan) · recent rides · your route"
          actions={active && <Badge value={active.state} dot>{active.state === "MATCHED" ? `Driver ${active.driverId} · ETA ${active.eta} min` : "finding driver"}</Badge>}>
          <FleetMap drivers={fleet.data?.drivers || []} rides={recent.data?.rides || []} marks={marks} onPick={pickOnMap} highlightDriver={active?.driverId} />
        </Card>

        <Card title="My rides" icon={Car} hint="polled from ride-service every 2.5 s">
          {myRides.length === 0 ? <Empty>No rides yet. Pick a pickup and drop and press Request ride.</Empty> : myRides.map((r) => (
            <div key={r.rideId} className="ride-card">
              <div className="row between">
                <div className="row"><Badge value={r.state} dot /><span className="mono tiny dim">{r.rideId.slice(0, 8)}</span></div>
                <div className="row">
                  <b>{fmtInr(r.fare)}</b>
                  {r.surge > 1 && <Badge tone="amber">surge ×{r.surge}</Badge>}
                  {r.fareEstimated && <Badge tone="amber" >fallback fare</Badge>}
                  {(r.state === "MATCHED" || r.state === "PENDING_MATCH") && <button className="btn sm" onClick={() => cancel(r.rideId)}><X size={13} />Cancel</button>}
                </div>
              </div>
              <div className="small muted mt-sm">
                {r.driverId ? <>Driver <b style={{ color: "var(--text)" }}>{r.driverId}</b> · ETA {r.eta} min</> : r.state === "PENDING_MATCH" ? "No driver yet: retrying in the background every 3 s" : "—"}
                <span className="dim"> · {timeAgo(r.createdAt)} · {fmtNum(haversineKm(r.pickup, r.drop), 1)} km</span>
              </div>
            </div>
          ))}
        </Card>

        <Card title="Platform-wide ride feed" icon={Users} hint={`${recent.data?.total ?? 0} rides in the store`}>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Ride</th><th>Rider</th><th>State</th><th>Driver</th><th className="num">Fare</th><th>When</th></tr></thead>
              <tbody>
                {(recent.data?.rides || []).slice(0, 10).map((r) => (
                  <tr key={r.rideId}>
                    <td className="mono tiny">{r.rideId.slice(0, 8)}</td>
                    <td className="small">{r.userId}</td>
                    <td><Badge value={r.state} /></td>
                    <td className="small">{r.driverId || "—"}</td>
                    <td className="num">{fmtInr(r.fare)}{r.fareEstimated ? " *" : ""}</td>
                    <td className="small muted">{timeAgo(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!(recent.data?.rides || []).length && <Empty>No rides yet.</Empty>}
            <div className="tiny dim mt-sm">* fare from the fallback path (pricing-service unavailable)</div>
          </div>
        </Card>
      </div>
    </div>
  );
}
