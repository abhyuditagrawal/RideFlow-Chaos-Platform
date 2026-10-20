import asyncio
import glob
import logging
import os
import random
import time
from contextlib import asynccontextmanager

import httpx
import yaml
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import BackgroundTasks, FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from .backends import SERVICE_URLS, build_backend
from .engine import ChaosEngine, SafetyError
from .metrics import ChaosMetrics
from .models import ExperimentDefinition
from .simulator import Simulator

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
logger = logging.getLogger("chaos.main")

EXPERIMENTS_DIR = os.getenv("EXPERIMENTS_DIR", "/app/experiments")
PORT = int(os.getenv("PORT", "9000"))

metrics = ChaosMetrics()
backend = build_backend()
engine = ChaosEngine(backend, metrics)
scheduler = AsyncIOScheduler()
simulator = Simulator(SERVICE_URLS["api-gateway"], SERVICE_URLS["driver-service"])
PROMETHEUS_URL = os.getenv("PROMETHEUS_URL", "http://prometheus:9090")

EXPERIMENTS: dict[str, ExperimentDefinition] = {}


def load_experiments() -> dict[str, ExperimentDefinition]:
    found = {}
    for path in glob.glob(os.path.join(EXPERIMENTS_DIR, "*.yaml")) + glob.glob(os.path.join(EXPERIMENTS_DIR, "*.yml")):
        try:
            raw = yaml.safe_load(open(path))
            if raw.get("fault", {}).get("type") not in (
                "pod_kill", "cpu_hog", "network_latency", "oom",
                "az_blackhole", "region_failure", "dependency_failure", "packet_loss",
            ):
                logger.info("skipping %s (not a single-fault experiment definition, e.g. game-day)", path)
                continue
            exp = ExperimentDefinition(**raw)
            found[exp.id] = exp
        except Exception as e:
            logger.warning("failed to load experiment %s: %s", path, e)
    logger.info("loaded %d experiment definitions", len(found))
    return found


@asynccontextmanager
async def lifespan(app: FastAPI):
    global EXPERIMENTS
    EXPERIMENTS = load_experiments()
    orphan = engine.find_orphaned_fault()
    if orphan:
        logger.warning("found orphaned active fault from a previous crash: %s — reverting", orphan)
        result = await engine.recover_orphaned_fault(EXPERIMENTS)
        logger.warning("crash recovery: %s", result)
    scheduler.start()
    # Experiments need live traffic and ride matching needs drivers, so the
    # simulator runs by default (SIMULATOR_AUTOSTART=false to opt out).
    if os.getenv("SIMULATOR_AUTOSTART", "true").lower() == "true":
        await simulator.start(rps=float(os.getenv("SIMULATOR_RPS", "4")),
                              drivers=int(os.getenv("SIMULATOR_DRIVERS", "30")))
    yield
    await simulator.stop()
    scheduler.shutdown(wait=False)


app = FastAPI(title="RideFlow Chaos Injector", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/healthz")
def healthz():
    return {"status": "ok", "service": "chaos-injector"}


@app.get("/readyz")
def readyz():
    return {"status": "ready", "backend": type(backend).__name__}


@app.get("/metrics")
def metrics_endpoint():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/experiments")
def list_experiments():
    return [e.model_dump() for e in EXPERIMENTS.values()]


@app.post("/experiments/{experiment_id}/run")
async def run_experiment(experiment_id: str, dryRun: bool = False):
    exp = EXPERIMENTS.get(experiment_id)
    if not exp:
        raise HTTPException(404, f"unknown experiment {experiment_id}")
    # Shielded: a run lasts minutes, and callers like the Vercel proxy hang up
    # after ~20s. Their disconnect must not cancel the experiment midway.
    task = asyncio.ensure_future(_run_and_record(exp, dryRun))
    _running_tasks.add(task)
    task.add_done_callback(_running_tasks.discard)
    try:
        run = await asyncio.shield(task)
    except SafetyError as e:
        raise HTTPException(409, str(e))
    return run.model_dump()


_running_tasks: set = set()


async def _run_and_record(exp, dry_run: bool):
    run = await engine.run_experiment(exp, dry_run=dry_run)
    if run.mttdSeconds is not None:
        metrics.mttd.labels(exp.id).set(run.mttdSeconds)
    if run.mttrSeconds is not None:
        metrics.mttr.labels(exp.id).set(run.mttrSeconds)
    return run


@app.get("/runs")
def list_runs():
    return [r.model_dump() for r in engine.list_runs()]


@app.delete("/runs")
def clear_runs():
    return {"removed": engine.clear_runs()}


@app.get("/runs/{run_id}")
def get_run(run_id: str):
    run = engine.get_run(run_id)
    if not run:
        raise HTTPException(404, "run not found")
    return run.model_dump()


@app.post("/abort")
async def abort():
    result = await engine.abort_all(EXPERIMENTS)
    return {"aborted": True, "detail": result}


async def _game_day_tick():
    if not engine.enabled or engine.is_running():
        return
    candidates = list(EXPERIMENTS.values())
    if not candidates:
        return
    exp = random.choice(candidates)
    logger.info("game-day: running %s", exp.id)
    try:
        await engine.run_experiment(exp)
    except SafetyError as e:
        logger.info("game-day: skipped (%s)", e)


@app.post("/schedule")
def enable_schedule(interval_seconds: int = 300):
    engine.set_enabled(True)
    scheduler.remove_all_jobs()
    scheduler.add_job(_game_day_tick, "interval", seconds=interval_seconds, id="game-day")
    return {"scheduled": True, "intervalSeconds": interval_seconds}


def _schedule_state():
    job = scheduler.get_job("game-day")
    if not job:
        return {"enabled": False, "intervalSeconds": None, "nextRunAt": None}
    nxt = job.next_run_time.timestamp() if job.next_run_time else None
    return {"enabled": True, "intervalSeconds": int(job.trigger.interval.total_seconds()), "nextRunAt": nxt}


@app.delete("/schedule")
def disable_schedule():
    scheduler.remove_all_jobs()
    return {"scheduled": False}


@app.post("/kill-switch")
def kill_switch(enabled: bool):
    engine.set_enabled(enabled)
    if not enabled:
        scheduler.remove_all_jobs()
    return {"enabled": engine.enabled}


@app.get("/metrics/summary")
async def metrics_summary():
    """Aggregated numbers for the dashboard's Overview tab — queried
    server-side so the browser never has to talk to Prometheus directly
    (avoids CORS entirely)."""
    queries = {
        "rps": 'sum(rate(http_requests_total{job="api-gateway"}[1m]))',
        "errorRate": 'sum(rate(http_requests_total{job="api-gateway",code=~"5.."}[1m])) / clamp_min(sum(rate(http_requests_total{job="api-gateway"}[1m])), 1e-9)',
        "p99LatencyMs": 'histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{job="api-gateway"}[1m])) by (le)) * 1000',
        "ridesPerMin": "sum(rate(rides_created_total[1m])) * 60",
    }
    out = {}
    async with httpx.AsyncClient(timeout=3.0) as c:
        for key, q in queries.items():
            try:
                r = await c.get(f"{os.getenv('PROMETHEUS_URL', 'http://prometheus:9090')}/api/v1/query", params={"query": q})
                result = r.json()["data"]["result"]
                val = float(result[0]["value"][1]) if result else 0.0
                out[key] = None if val != val else round(val, 3)  # NaN -> null
            except Exception:
                out[key] = None
    return out


@app.get("/status")
async def status():
    """One-call summary for the live dashboard: injector state + a quick
    health probe of every downstream service."""
    health = {}
    async with httpx.AsyncClient(timeout=1.5) as c:
        for name, url in SERVICE_URLS.items():
            try:
                r = await c.get(f"{url}/healthz")
                health[name] = r.status_code == 200
            except Exception:
                health[name] = False
    recent = engine.list_runs()[:10]
    return {
        "enabled": engine.enabled,
        "backend": type(backend).__name__,
        "activeRun": engine._active_run.model_dump() if engine._active_run else None,
        "serviceHealth": health,
        "recentRuns": [r.model_dump() for r in recent],
        "experimentCount": len(EXPERIMENTS),
        "simulator": simulator.snapshot(),
        "schedule": _schedule_state(),
        "timestamp": time.time(),
    }


# ---------- simulator ----------
@app.get("/simulator")
def simulator_state():
    return simulator.snapshot()


@app.post("/simulator/start")
async def simulator_start(rps: float = 4.0, drivers: int = 30):
    await simulator.start(rps=rps, drivers=drivers)
    return simulator.snapshot()


@app.post("/simulator/stop")
async def simulator_stop():
    await simulator.stop()
    return simulator.snapshot()


@app.get("/fleet")
def fleet():
    return {"drivers": simulator.drivers(), "running": simulator.running}


# ---------- metrics for the dashboard's charts ----------
async def _prom_query(c: httpx.AsyncClient, q: str):
    r = await c.get(f"{PROMETHEUS_URL}/api/v1/query", params={"query": q})
    return r.json()["data"]["result"]


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f or f in (float("inf"), float("-inf")) else round(f, 4)


HISTORY_QUERIES = {
    "rps": 'sum(rate(http_requests_total{job="api-gateway",route!="/healthz"}[1m]))',
    "errorRate": '(sum(rate(http_requests_total{job="api-gateway",code=~"5.."}[1m])) or vector(0)) / clamp_min(sum(rate(http_requests_total{job="api-gateway"}[1m])), 1e-9)',
    "p99Ms": 'histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{job="api-gateway"}[1m])) by (le)) * 1000',
    "p50Ms": 'histogram_quantile(0.50, sum(rate(http_request_duration_seconds_bucket{job="api-gateway"}[1m])) by (le)) * 1000',
    "ridesPerMin": "sum(rate(rides_created_total[1m])) * 60",
}


@app.get("/metrics/history")
async def metrics_history(minutes: int = 15):
    """Time series for the Overview charts, merged into one row per timestamp."""
    minutes = max(1, min(minutes, 180))
    end = time.time()
    start = end - minutes * 60
    step = max(5, int(minutes * 60 / 150))
    rows: dict[float, dict] = {}
    async with httpx.AsyncClient(timeout=5.0) as c:
        for key, q in HISTORY_QUERIES.items():
            try:
                r = await c.get(f"{PROMETHEUS_URL}/api/v1/query_range",
                                params={"query": q, "start": start, "end": end, "step": step})
                result = r.json()["data"]["result"]
                for ts, val in (result[0]["values"] if result else []):
                    rows.setdefault(float(ts), {"t": float(ts)})[key] = _num(val)
            except Exception as e:
                logger.warning("history query %s failed: %s", key, e)
    return {"step": step, "points": [rows[t] for t in sorted(rows)]}


@app.get("/metrics/services")
async def metrics_services():
    """Per-service RED metrics (rate, errors, duration) for the services table."""
    out = {name: {"rps": None, "errorRate": None, "p99Ms": None, "up": None} for name in SERVICE_URLS}
    queries = {
        "rps": 'sum by (job) (rate(http_requests_total{route!="/healthz",route!="/metrics"}[1m]))',
        "errorRate": 'sum by (job) (rate(http_requests_total{code=~"5.."}[1m])) / clamp_min(sum by (job) (rate(http_requests_total[1m])), 1e-9)',
        "p99Ms": 'histogram_quantile(0.99, sum by (job, le) (rate(http_request_duration_seconds_bucket[1m]))) * 1000',
        "up": "up",
    }
    async with httpx.AsyncClient(timeout=5.0) as c:
        for key, q in queries.items():
            try:
                for series in await _prom_query(c, q):
                    job = series["metric"].get("job")
                    if job in out:
                        out[job][key] = _num(series["value"][1])
            except Exception as e:
                logger.warning("services query %s failed: %s", key, e)
    for m in out.values():
        # no 5xx series / no non-health traffic just means zero, not unknown
        if m["up"] == 1:
            m["errorRate"] = m["errorRate"] or 0.0
            m["rps"] = m["rps"] or 0.0
    return {"services": out}


@app.get("/breakers")
async def breakers():
    """Live circuit-breaker states (0 closed, 1 half-open, 2 open)."""
    names = {0: "closed", 1: "half_open", 2: "open"}
    out = []
    async with httpx.AsyncClient(timeout=5.0) as c:
        try:
            for series in await _prom_query(c, "max by (service, dependency) (circuit_breaker_state)"):
                v = _num(series["value"][1])
                out.append({"service": series["metric"].get("service"), "dependency": series["metric"].get("dependency"),
                            "state": names.get(int(v) if v is not None else -1, "unknown")})
        except Exception as e:
            logger.warning("breaker query failed: %s", e)
    return {"breakers": sorted(out, key=lambda b: (b["service"] or "", b["dependency"] or ""))}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
