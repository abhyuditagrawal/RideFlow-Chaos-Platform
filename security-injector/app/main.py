import asyncio
import glob
import logging
import os
import time
from contextlib import asynccontextmanager

import httpx
import yaml
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from .attacks import SERVICE_URLS
from .engine import AttackEngine, SafetyError
from .models import AttackDefinition

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
logger = logging.getLogger("security.main")

ATTACKS_DIR = os.getenv("ATTACKS_DIR", "/app/attacks")
PORT = int(os.getenv("PORT", "9001"))

engine = AttackEngine()
ATTACKS: dict[str, AttackDefinition] = {}


def load_attacks() -> dict[str, AttackDefinition]:
    found = {}
    for path in glob.glob(os.path.join(ATTACKS_DIR, "*.yaml")) + glob.glob(os.path.join(ATTACKS_DIR, "*.yml")):
        try:
            raw = yaml.safe_load(open(path))
            defn = AttackDefinition(**raw)
            found[defn.id] = defn
        except Exception as e:
            logger.warning("failed to load attack definition %s: %s", path, e)
    logger.info("loaded %d attack definitions", len(found))
    return found


@asynccontextmanager
async def lifespan(app: FastAPI):
    global ATTACKS
    ATTACKS = load_attacks()
    yield


app = FastAPI(title="RideFlow Security Attack Simulator", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/healthz")
def healthz():
    return {"status": "ok", "service": "security-injector"}


@app.get("/readyz")
def readyz():
    return {"status": "ready"}


@app.get("/metrics")
def metrics_endpoint():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/attacks")
def list_attacks():
    return [a.model_dump() for a in ATTACKS.values()]


@app.post("/attacks/{attack_id}/run")
async def run_attack(attack_id: str):
    defn = ATTACKS.get(attack_id)
    if not defn:
        raise HTTPException(404, f"unknown attack {attack_id}")
    # Shielded so a caller hanging up (the Vercel proxy answers after ~20s)
    # doesn't cancel the attack midway.
    task = asyncio.ensure_future(engine.run_attack(defn))
    _running_tasks.add(task)
    task.add_done_callback(_running_tasks.discard)
    try:
        run = await asyncio.shield(task)
    except SafetyError as e:
        raise HTTPException(409, str(e))
    return run.model_dump()


_running_tasks: set = set()


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
    detail = await engine.abort()
    return {"aborted": True, "detail": detail}


@app.post("/kill-switch")
def kill_switch(enabled: bool):
    engine.set_enabled(enabled)
    return {"enabled": engine.enabled}


@app.get("/posture")
def posture():
    return engine.security_posture()


@app.get("/status")
async def status():
    health = {}
    async with httpx.AsyncClient(timeout=1.5) as c:
        for name, url in SERVICE_URLS.items():
            try:
                r = await c.get(f"{url}/healthz")
                health[name] = r.status_code == 200
            except Exception:
                health[name] = False
    return {
        "enabled": engine.enabled,
        "activeRun": engine._active_run.model_dump() if engine._active_run else None,
        "serviceHealth": health,
        "recentRuns": [r.model_dump() for r in engine.list_runs()[:10]],
        "attackCount": len(ATTACKS),
        "posture": engine.security_posture(),
        "timestamp": time.time(),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
