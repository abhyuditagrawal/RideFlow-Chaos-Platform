"""ride-service — ride lifecycle orchestration and state machine.

Degradation rules (this is what the chaos experiments exercise):
  pricing-service down  -> use last known base fare per zone, fareEstimated=true, still 201
  driver-service down   -> create ride in PENDING_MATCH, background retry every 3s for 60s, 202
  datastore down        -> fail fast, 503 (no local queue)
"""
import asyncio
import os
import time
import uuid
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest
from pydantic import BaseModel

from .circuit_breaker import CircuitBreaker

SERVICE = "ride-service"
PORT = int(os.getenv("PORT", "8082"))
REGION = os.getenv("REGION", "local")
PRICING_URL = os.getenv("PRICING_URL", "http://pricing-service:8084")
DRIVER_URL = os.getenv("DRIVER_URL", "http://driver-service:8083")

REQS = Counter("http_requests_total", "requests", ["service", "method", "route", "code"])
DUR = Histogram("http_request_duration_seconds", "latency", ["service", "method", "route"])
INFLIGHT = Gauge("http_requests_in_flight", "in flight", ["service"])
DEP_REQS = Counter("dependency_requests_total", "dependency calls", ["service", "dependency", "outcome"])
CB_STATE = Gauge("circuit_breaker_state", "0 closed 1 half 2 open", ["service", "dependency"])
RIDES_CREATED = Counter("rides_created_total", "rides created")

pricing_cb = CircuitBreaker()
driver_cb = CircuitBreaker()

# in-memory store standing in for DynamoDB `rides` in local/dev; swap for a
# boto3 DynamoDB client behind the same interface when running on AWS.
RIDES: dict[str, dict] = {}
MAX_RIDES = int(os.getenv("MAX_RIDES", "5000"))
LAST_KNOWN_BASE_FARE = {"default": 55.0}

client = httpx.AsyncClient(timeout=httpx.Timeout(connect=0.8, read=2.0, write=2.0, pool=2.0))


class RideRequest(BaseModel):
    userId: str
    pickup: dict
    drop: dict


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await client.aclose()


app = FastAPI(lifespan=lifespan)
_runtime_fault = {"mode": os.getenv("CHAOS_INJECT", "")}


@app.patch("/admin/chaos")
def set_chaos(mode: str = ""):
    _runtime_fault["mode"] = mode
    return {"mode": mode}


@app.middleware("http")
async def metrics_and_chaos(request: Request, call_next):
    INFLIGHT.labels(SERVICE).inc()
    start = time.time()
    # /admin/chaos must never be affected by the fault it itself controls —
    # otherwise setting mode=error makes the toggle permanently unreachable
    if request.url.path == "/admin/chaos":
        response = await call_next(request)
        INFLIGHT.labels(SERVICE).dec()
        DUR.labels(SERVICE, request.method, request.url.path).observe(time.time() - start)
        REQS.labels(SERVICE, request.method, request.url.path, str(response.status_code)).inc()
        return response
    fault = request.headers.get("x-chaos-fault") or _runtime_fault["mode"]
    if fault == "latency":
        await asyncio.sleep(float(os.getenv("CHAOS_LATENCY_MS", "300")) / 1000)
    elif fault == "error":
        INFLIGHT.labels(SERVICE).dec()
        REQS.labels(SERVICE, request.method, request.url.path, "500").inc()
        return Response(status_code=500, content="chaos-injected error")
    try:
        response = await call_next(request)
    finally:
        INFLIGHT.labels(SERVICE).dec()
    DUR.labels(SERVICE, request.method, request.url.path).observe(time.time() - start)
    REQS.labels(SERVICE, request.method, request.url.path, str(response.status_code)).inc()
    for name, cb in (("pricing-service", pricing_cb), ("driver-service", driver_cb)):
        CB_STATE.labels(SERVICE, name).set(int(cb.state))
    return response


@app.get("/healthz")
def healthz():
    return {"status": "ok", "service": SERVICE, "region": REGION}


@app.get("/readyz")
def readyz():
    return {"status": "ready"}


@app.get("/metrics")
def metrics():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


async def get_quote(distance_km: float, eta_min: float) -> tuple[float, float, bool]:
    if not pricing_cb.allow():
        DEP_REQS.labels(SERVICE, "pricing-service", "short_circuited").inc()
        return LAST_KNOWN_BASE_FARE["default"], 1.0, True
    try:
        r = await client.post(f"{PRICING_URL}/internal/quote", json={"distance_km": distance_km, "eta_min": eta_min})
        r.raise_for_status()
        data = r.json()
        pricing_cb.record_success()
        DEP_REQS.labels(SERVICE, "pricing-service", "success").inc()
        LAST_KNOWN_BASE_FARE["default"] = data["fare"]
        return data["fare"], data["surge"], False
    except Exception:
        pricing_cb.record_failure()
        DEP_REQS.labels(SERVICE, "pricing-service", "failure").inc()
        return LAST_KNOWN_BASE_FARE["default"], 1.0, True


async def try_match(ride_id: str, pickup: dict) -> dict | None:
    if not driver_cb.allow():
        DEP_REQS.labels(SERVICE, "driver-service", "short_circuited").inc()
        return None
    try:
        r = await client.post(f"{DRIVER_URL}/internal/match", json={"lat": pickup["lat"], "lng": pickup["lng"], "radiusKm": 5})
        r.raise_for_status()
        driver_cb.record_success()
        DEP_REQS.labels(SERVICE, "driver-service", "success").inc()
        return r.json()
    except Exception:
        driver_cb.record_failure()
        DEP_REQS.labels(SERVICE, "driver-service", "failure").inc()
        return None


async def background_match_retry(ride_id: str):
    deadline = time.time() + 60
    while time.time() < deadline:
        await asyncio.sleep(3)
        ride = RIDES.get(ride_id)
        if not ride or ride["state"] != "PENDING_MATCH":
            return
        match = await try_match(ride_id, ride["pickup"])
        if match:
            ride["driverId"] = match["driverId"]
            ride["eta"] = match.get("eta")
            ride["state"] = "MATCHED"
            ride["updatedAt"] = time.time()
            return


def haversine_km(a: dict, b: dict) -> float:
    from math import radians, sin, cos, asin, sqrt
    lat1, lon1, lat2, lon2 = map(radians, [a["lat"], a["lng"], b["lat"], b["lng"]])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return 2 * 6371 * asin(sqrt(h))


@app.post("/internal/rides", status_code=201)
async def create_ride(req: RideRequest, response: Response):
    ride_id = str(uuid.uuid4())
    distance_km = max(0.5, haversine_km(req.pickup, req.drop))
    eta_min = distance_km * 2.2

    fare, surge, estimated = await get_quote(distance_km, eta_min)

    ride = {
        "rideId": ride_id, "userId": req.userId, "state": "QUOTED",
        "pickup": req.pickup, "drop": req.drop, "fare": fare, "surge": surge,
        "fareEstimated": estimated, "driverId": None, "eta": None,
        "createdAt": time.time(), "updatedAt": time.time(), "region": REGION,
    }
    RIDES[ride_id] = ride
    # in-memory store: keep the newest MAX_RIDES so a long-running simulator
    # can't grow it without bound (dicts keep insertion order)
    while len(RIDES) > MAX_RIDES:
        RIDES.pop(next(iter(RIDES)))

    match = await try_match(ride_id, req.pickup)
    if match:
        ride["driverId"] = match["driverId"]
        ride["eta"] = match.get("eta")
        ride["state"] = "MATCHED"
        RIDES_CREATED.inc()
        return ride

    ride["state"] = "PENDING_MATCH"
    RIDES_CREATED.inc()
    asyncio.create_task(background_match_retry(ride_id))
    response.status_code = 202
    return ride


@app.get("/internal/rides")
def list_rides(userId: str | None = None, limit: int = 50):
    rides = [r for r in RIDES.values() if userId is None or r["userId"] == userId]
    return {"rides": list(reversed(rides))[: max(1, min(limit, 500))], "total": len(RIDES)}


@app.get("/internal/rides/{ride_id}")
def get_ride(ride_id: str):
    ride = RIDES.get(ride_id)
    if not ride:
        raise HTTPException(404, "ride not found")
    return ride


@app.patch("/internal/rides/{ride_id}")
def patch_ride(ride_id: str, body: dict):
    ride = RIDES.get(ride_id)
    if not ride:
        raise HTTPException(404, "ride not found")
    ride.update(body)
    ride["updatedAt"] = time.time()
    return ride


@app.post("/internal/rides/{ride_id}/cancel")
def cancel_ride(ride_id: str):
    ride = RIDES.get(ride_id)
    if not ride:
        raise HTTPException(404, "ride not found")
    ride["state"] = "CANCELLED"
    ride["updatedAt"] = time.time()
    return ride


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
