import asyncio
import json
import logging
import os
import time
import uuid
from pathlib import Path

import httpx

from . import metrics as m
from .attacks import ATTACK_FUNCS, SERVICE_URLS
from .models import AttackDefinition, AttackRun

logger = logging.getLogger("security.engine")

STATE_DIR = Path(os.getenv("SECURITY_STATE_DIR", "/tmp/security-state"))
STATE_DIR.mkdir(parents=True, exist_ok=True)
RUNS_FILE = STATE_DIR / "runs.json"


class SafetyError(Exception):
    pass


class AttackEngine:
    """Mirrors chaos-injector's engine shape deliberately: one active run at
    a time, a global kill switch, and everything scoped to our own services
    (attacks.py hardcodes SERVICE_URLS — there is no way to pass an
    arbitrary target into this engine)."""

    def __init__(self):
        self._lock = asyncio.Lock()
        self._active_run: AttackRun | None = None
        self._active_task: asyncio.Task | None = None
        self._enabled = True
        self._client = httpx.AsyncClient(timeout=10.0)
        self._runs: dict[str, AttackRun] = self._load_runs()

    def _load_runs(self) -> dict[str, AttackRun]:
        if RUNS_FILE.exists():
            try:
                raw = json.loads(RUNS_FILE.read_text())
                return {k: AttackRun(**v) for k, v in raw.items()}
            except Exception:
                return {}
        return {}

    def _save_runs(self):
        RUNS_FILE.write_text(json.dumps({k: v.model_dump() for k, v in self._runs.items()}))

    def clear_runs(self) -> int:
        """Forget finished runs (e.g. before a demo); an active run is kept."""
        keep = {k: v for k, v in self._runs.items() if self._active_run is not None and k == self._active_run.runId}
        removed = len(self._runs) - len(keep)
        self._runs = keep
        self._save_runs()
        return removed

    def set_enabled(self, enabled: bool):
        self._enabled = enabled

    @property
    def enabled(self) -> bool:
        return self._enabled

    def is_running(self) -> bool:
        return self._active_run is not None and self._active_run.status == "running"

    async def run_attack(self, definition: AttackDefinition) -> AttackRun:
        if not self._enabled:
            raise SafetyError("security testing is globally disabled (kill switch)")
        if definition.target_service not in SERVICE_URLS:
            raise SafetyError(f"unknown target service {definition.target_service!r} — refusing to run")
        func = ATTACK_FUNCS.get(definition.type)
        if not func:
            raise SafetyError(f"unknown attack type {definition.type!r}")

        async with self._lock:
            if self.is_running():
                raise SafetyError("another attack is already running — concurrency limit is 1")
            run = AttackRun(runId=str(uuid.uuid4()), attackId=definition.id, status="running", startedAt=time.time())
            self._active_run = run
            self._runs[run.runId] = run
            self._save_runs()

        run.log.append(f"starting {definition.type} against {definition.target_service}")
        task = asyncio.create_task(self._execute(definition, run))
        self._active_task = task
        try:
            await task
        except asyncio.CancelledError:
            # _execute normally records the abort itself; this covers a cancel
            # that landed before the task ever started (its finally never ran,
            # which would otherwise leave the engine stuck "running" forever)
            if run.status == "running":
                run.status = "aborted"
                run.log.append("ABORTED by operator")
                run.finishedAt = time.time()
                self._active_run = None
                self._active_task = None
                self._save_runs()
        return run

    async def _execute(self, definition: AttackDefinition, run: AttackRun):
        try:
            findings = await ATTACK_FUNCS[definition.type](self._client, definition.params)
            run.findings = findings
            failed = [f for f in findings if not f.passed]
            if not findings:
                run.verdict = "unknown"
            elif not failed:
                run.verdict = "defended"
            elif len(failed) == len(findings):
                run.verdict = "vulnerable"
            else:
                run.verdict = "partial"
            run.status = "completed"
            for f in findings:
                m.findings_total.labels(definition.id, f.check, str(f.passed)).inc()
                m.vulnerabilities_open.labels(definition.id, f.check).set(0 if f.passed else 1)
            m.runs_total.labels(definition.id, run.verdict).inc()
            run.log.append(f"completed: verdict={run.verdict}, {len(failed)}/{len(findings)} findings failed")
        except asyncio.CancelledError:
            # set before the finally below persists the run, otherwise it was
            # saved to disk as "running" and only flipped to "aborted" in memory
            run.status = "aborted"
            run.log.append("ABORTED by operator")
            raise
        except Exception as e:
            run.status = "error"
            run.log.append(f"ERROR: {e}")
            logger.exception("attack %s failed", definition.id)
        finally:
            run.finishedAt = time.time()
            self._active_run = None
            self._active_task = None
            self._runs[run.runId] = run
            self._save_runs()

    async def abort(self) -> str:
        if self._active_task and not self._active_task.done():
            self._active_task.cancel()
            return "cancellation requested for the active attack run"
        return "no active attack to abort"

    def get_run(self, run_id: str) -> AttackRun | None:
        return self._runs.get(run_id)

    def list_runs(self) -> list[AttackRun]:
        return sorted(self._runs.values(), key=lambda r: r.startedAt or 0, reverse=True)

    def security_posture(self) -> dict:
        """A rollup used by the dashboard: latest verdict per attack type,
        and an overall score. Genuinely useful summary, not just a list."""
        latest_by_attack: dict[str, AttackRun] = {}
        for run in self.list_runs():
            if run.status == "completed" and run.attackId not in latest_by_attack:
                latest_by_attack[run.attackId] = run
        total = len(latest_by_attack)
        defended = sum(1 for r in latest_by_attack.values() if r.verdict == "defended")
        return {
            "attacksEvaluated": total,
            "defended": defended,
            "vulnerableOrPartial": total - defended,
            "score": round(100 * defended / total, 1) if total else None,
            "latest": {k: v.model_dump() for k, v in latest_by_attack.items()},
        }
