"""Traffic + fleet simulator.

Chaos experiments measure steady-state metrics (error rate, p99, rides/min),
and those are undefined without traffic; ride matching needs drivers in the
driver-service geo index. This keeps both alive: a fleet of drivers random-
walking around Mumbai (location heartbeats to driver-service) and a stream of
ride bookings through the public api-gateway, at a configurable rate.
"""
import asyncio
import logging
import random
import time
from collections import deque

import httpx

logger = logging.getLogger("chaos.simulator")

# Mumbai, roughly Colaba to Borivali
CITY_CENTER = (19.076, 72.877)
LAT_RANGE = (18.92, 19.24)
LNG_RANGE = (72.80, 72.98)

PLACES = [
    ("Gateway of India", 18.9220, 72.8347), ("CST Station", 18.9398, 72.8355),
    ("Marine Drive", 18.9440, 72.8232), ("Worli Sea Face", 19.0096, 72.8150),
    ("Dadar", 19.0178, 72.8478), ("Bandra Station", 19.0544, 72.8406),
    ("BKC", 19.0662, 72.8654), ("Mumbai Airport T2", 19.0974, 72.8742),
    ("Powai Lake", 19.1260, 72.9050), ("Andheri", 19.1197, 72.8464),
    ("Juhu Beach", 19.0988, 72.8267), ("Goregaon", 19.1663, 72.8526),
    ("Malad", 19.1874, 72.8484), ("Ghatkopar", 19.0860, 72.9081),
    ("Kurla", 19.0726, 72.8845), ("Lower Parel", 18.9953, 72.8300),
]


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


class Simulator:
    def __init__(self, gateway_url: str, driver_url: str):
        self.gateway_url = gateway_url
        self.driver_url = driver_url
        self.running = False
        self.rps = 4.0
        self.driver_count = 30
        self.started_at: float | None = None
        self._tasks: list[asyncio.Task] = []
        self._drivers: dict[str, list[float]] = {}
        self.stats = self._fresh_stats()
        self._recent = deque(maxlen=200)  # (t, ok, latency_ms)

    @staticmethod
    def _fresh_stats():
        return {"sent": 0, "ok": 0, "errors": 0, "matched": 0, "pending": 0,
                "fareEstimated": 0, "lastError": None}

    def drivers(self):
        return [{"id": d, "lat": round(p[0], 5), "lng": round(p[1], 5)} for d, p in self._drivers.items()]

    def snapshot(self):
        now = time.time()
        window = [r for r in self._recent if now - r[0] <= 30]
        lat = sorted(r[2] for r in window if r[1])
        return {
            "running": self.running,
            "rps": self.rps,
            "driverCount": self.driver_count,
            "activeDrivers": len(self._drivers),
            "startedAt": self.started_at,
            "stats": dict(self.stats),
            "last30s": {
                "requests": len(window),
                "successRate": round(sum(1 for r in window if r[1]) / len(window), 4) if window else None,
                "p50Ms": round(lat[len(lat) // 2], 1) if lat else None,
                "p95Ms": round(lat[int(len(lat) * 0.95) - 1], 1) if lat else None,
            },
        }

    async def start(self, rps: float | None = None, drivers: int | None = None):
        if rps is not None:
            self.rps = _clamp(float(rps), 0.5, 20.0)
        if drivers is not None:
            self.driver_count = int(_clamp(int(drivers), 1, 200))
        await self.stop()
        self.running = True
        self.started_at = time.time()
        self.stats = self._fresh_stats()
        self._recent.clear()
        self._seed_drivers()
        self._tasks = [asyncio.create_task(self._fleet_loop()), asyncio.create_task(self._traffic_loop())]
        logger.info("simulator started: %.1f rps, %d drivers", self.rps, self.driver_count)

    async def stop(self):
        self.running = False
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        self._tasks = []

    def _seed_drivers(self):
        self._drivers = {}
        for i in range(self.driver_count):
            name, lat, lng = random.choice(PLACES)
            self._drivers[f"DRV-{i + 1:03d}"] = [lat + random.uniform(-0.02, 0.02), lng + random.uniform(-0.02, 0.02)]

    async def _fleet_loop(self):
        async with httpx.AsyncClient(timeout=3.0) as c:
            while self.running:
                for d, pos in list(self._drivers.items()):
                    pos[0] = _clamp(pos[0] + random.uniform(-0.004, 0.004), *LAT_RANGE)
                    pos[1] = _clamp(pos[1] + random.uniform(-0.004, 0.004), *LNG_RANGE)
                    try:
                        await c.put(f"{self.driver_url}/internal/drivers/{d}/location", json={"lat": pos[0], "lng": pos[1]})
                    except Exception:
                        pass  # driver-service down is an experiment, not a simulator bug
                await asyncio.sleep(5)

    async def _book_one(self, c: httpx.AsyncClient):
        a, b = random.sample(PLACES, 2)
        body = {
            "userId": f"sim-{random.randint(1, 500):04d}",
            "pickup": {"lat": a[1] + random.uniform(-0.005, 0.005), "lng": a[2] + random.uniform(-0.005, 0.005)},
            "drop": {"lat": b[1], "lng": b[2]},
        }
        t = time.time()
        self.stats["sent"] += 1
        try:
            r = await c.post(f"{self.gateway_url}/v1/rides", json=body)
            ms = (time.time() - t) * 1000
            ok = r.status_code < 500
            self._recent.append((time.time(), ok, ms))
            if ok:
                self.stats["ok"] += 1
                try:
                    ride = r.json()
                    if ride.get("state") == "MATCHED":
                        self.stats["matched"] += 1
                    elif ride.get("state") == "PENDING_MATCH":
                        self.stats["pending"] += 1
                    if ride.get("fareEstimated"):
                        self.stats["fareEstimated"] += 1
                except Exception:
                    pass
            else:
                self.stats["errors"] += 1
                self.stats["lastError"] = f"HTTP {r.status_code}"
        except Exception as e:
            self._recent.append((time.time(), False, (time.time() - t) * 1000))
            self.stats["errors"] += 1
            self.stats["lastError"] = type(e).__name__

    async def _traffic_loop(self):
        async with httpx.AsyncClient(timeout=5.0) as c:
            pending: set[asyncio.Task] = set()
            while self.running:
                # fire-and-forget so a slow gateway (an experiment) lowers
                # nothing but latency, like real independent users would
                task = asyncio.create_task(self._book_one(c))
                pending.add(task)
                task.add_done_callback(pending.discard)
                await asyncio.sleep(random.expovariate(self.rps))
            for t in pending:
                t.cancel()
