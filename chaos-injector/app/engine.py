"""The actual contribution of this project: a hypothesis-first fault-injection
and recovery-measurement engine (doc §8.1, §8.3 execution lifecycle).

ValidateHypothesis -> CheckBlastRadius -> InjectFault -> RecordT0 -> Monitor
  -> (EmergencyRevert | RevertFault) -> MeasureRecovery -> EmitReport
"""
import asyncio
import json
import logging
import math
import os
import re
import time
import uuid
from pathlib import Path

import httpx

from .backends import FaultBackend, target_service_from_selector
from .models import ExperimentDefinition, RunResult

logger = logging.getLogger("chaos.engine")

STATE_DIR = Path(os.getenv("CHAOS_STATE_DIR", "/tmp/chaos-state"))
STATE_DIR.mkdir(parents=True, exist_ok=True)
ACTIVE_FAULT_FILE = STATE_DIR / "active_fault.json"
RUNS_FILE = STATE_DIR / "runs.json"

PROMETHEUS_URL = os.getenv("PROMETHEUS_URL", "http://prometheus:9090")
GRAFANA_URL = os.getenv("GRAFANA_URL", "")
GRAFANA_USER = os.getenv("GRAFANA_USER", "admin")
GRAFANA_PASSWORD = os.getenv("GRAFANA_PASSWORD", "admin")


def parse_duration(s: str) -> float:
    m = re.match(r"^(\d+(?:\.\d+)?)(s|m|h)?$", s.strip())
    if not m:
        raise ValueError(f"bad duration: {s}")
    value, unit = float(m.group(1)), m.group(2) or "s"
    return value * {"s": 1, "m": 60, "h": 3600}[unit]


def compare(value: float, op: str, threshold: float) -> bool:
    return {
        "<": value < threshold, ">": value > threshold,
        "<=": value <= threshold, ">=": value >= threshold, "==": value == threshold,
    }[op]


class SafetyError(Exception):
    pass


class ChaosEngine:
    def __init__(self, backend: FaultBackend, metrics):
        self.backend = backend
        self.metrics = metrics
        self._lock = asyncio.Lock()
        self._active_run: RunResult | None = None
        self._enabled = True  # global kill switch, ConfigMap `chaos-enabled` in real deploy
        self._http = httpx.AsyncClient(timeout=10.0)
        self._runs: dict[str, RunResult] = self._load_runs()
        self._revert_fn = None  # set while a fault is active, used by /abort
        # Set by /abort. The run coroutine checks it between every phase, so an
        # operator abort actually ends the run instead of only reverting the
        # fault while monitoring/recovery carries on and reports "pass".
        self._abort_event = asyncio.Event()

    # ---- persistence (so a crash-restart can auto-revert, doc §8.5) ----
    def _load_runs(self) -> dict[str, RunResult]:
        if RUNS_FILE.exists():
            try:
                raw = json.loads(RUNS_FILE.read_text())
                return {k: RunResult(**v) for k, v in raw.items()}
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

    def record_active_fault(self, run_id: str, experiment_id: str):
        ACTIVE_FAULT_FILE.write_text(json.dumps({"runId": run_id, "experimentId": experiment_id, "t0": time.time()}))

    def clear_active_fault(self):
        if ACTIVE_FAULT_FILE.exists():
            ACTIVE_FAULT_FILE.unlink()

    def find_orphaned_fault(self) -> dict | None:
        if ACTIVE_FAULT_FILE.exists():
            return json.loads(ACTIVE_FAULT_FILE.read_text())
        return None

    # ---- safety controls (doc §8.5) ----
    def set_enabled(self, enabled: bool):
        self._enabled = enabled

    @property
    def enabled(self) -> bool:
        return self._enabled

    def is_running(self) -> bool:
        # an aborted run still occupies the slot until its coroutine has
        # finished reverting, so a second experiment can't start under it
        return self._active_run is not None

    async def steady_state_holds(self, conditions) -> tuple[bool, str | None]:
        for cond in conditions:
            try:
                r = await self._http.get(f"{PROMETHEUS_URL}/api/v1/query", params={"query": cond.metric})
                r.raise_for_status()
                result = r.json()["data"]["result"]
                value = float(result[0]["value"][1]) if result else 0.0
            except Exception as e:
                logger.warning("prometheus query failed (%s) — treating as unmet", e)
                return False, cond.metric
            if math.isnan(value):
                # 0/0 rates and empty histograms come back as NaN when there's
                # no traffic; say so instead of reporting a mystery breach
                return False, f"{cond.metric} (no data: is there traffic?)"
            if not compare(value, cond.operator, cond.threshold):
                return False, cond.metric
        return True, None

    async def post_annotation(self, text: str, tags: list[str]):
        if not GRAFANA_URL:
            return
        try:
            # anonymous access is Viewer-only (read-only) in this stack's
            # Grafana config, so posting annotations needs real auth —
            # without this, the call used to "succeed" with a 403 that
            # nothing ever checked, silently dropping every fault-window
            # annotation the dashboards are supposed to show.
            r = await self._http.post(
                f"{GRAFANA_URL}/api/annotations",
                json={"text": text, "tags": tags, "time": int(time.time() * 1000)},
                auth=(GRAFANA_USER, GRAFANA_PASSWORD),
            )
            r.raise_for_status()
        except Exception as e:
            logger.warning("grafana annotation failed: %s", e)

    async def run_experiment(self, exp: ExperimentDefinition, dry_run: bool = False) -> RunResult:
        if not self._enabled:
            raise SafetyError("chaos is globally disabled (kill switch) — enable via /schedule or config")
        if exp.fault.selector.namespace in exp.blast_radius.forbidden_namespaces:
            raise SafetyError(f"namespace {exp.fault.selector.namespace} is in the forbidden list")
        async with self._lock:
            if self.is_running():
                raise SafetyError("another experiment is already active — concurrency limit is 1")

            run_id = str(uuid.uuid4())
            run = RunResult(runId=run_id, experimentId=exp.id, status="running", dryRun=dry_run)
            self._active_run = run
            self._runs[run_id] = run
            self._abort_event.clear()
            self._save_runs()

        log = run.log
        try:
            # ValidateHypothesis
            holds, failing = await self.steady_state_holds(exp.steady_state)
            if not holds:
                log.append(f"ABORT: steady state not met before start (failing metric: {failing})")
                run.status, run.result = "aborted", "fail"
                return run

            # CheckBlastRadius
            if exp.fault.count > exp.blast_radius.max_pods_affected:
                log.append("ABORT: fault count exceeds blast_radius.max_pods_affected")
                run.status, run.result = "aborted", "fail"
                return run

            service = None
            if exp.fault.selector.labelSelector:
                service = target_service_from_selector(exp.fault.selector.labelSelector)

            if dry_run:
                log.append(f"[dry-run] would inject {exp.fault.type} against {service or exp.fault.selector.zone}")
                run.status, run.result = "pass", "pass"
                return run

            if self._abort_event.is_set():
                log.append("ABORTED by operator before injection, no fault injected")
                run.status, run.result = "aborted", "fail"
                return run

            # Record intent BEFORE injecting, not after: if the process dies
            # mid-injection-call, startup's orphaned-fault check still finds
            # a record to revert against. A revert call when nothing was
            # actually injected yet is a harmless no-op for every fault type
            # here, so recording early costs nothing and closes a real gap.
            self.record_active_fault(run_id, exp.id)
            self._revert_fn = lambda: self._revert(exp, service)

            # InjectFault + RecordT0
            action_desc = await self._inject(exp, service)
            t0 = time.time()
            run.t0 = t0
            log.append(f"t0={t0:.3f} INJECT {exp.fault.type}: {action_desc}")
            self._save_runs()
            await self.post_annotation(f"chaos:{exp.id} START", ["chaos", exp.fault.type])
            self.metrics.active_faults.labels(exp.fault.type, service or exp.fault.selector.zone or "region").inc()

            # Monitor -> Revert (duration elapsed or abort condition hit)
            duration_s = parse_duration(exp.duration)
            aborted = await self._monitor(exp, run, duration_s)

            # Revert (on an operator abort, abort_all already reverted; doing
            # it again is a no-op for every fault type and covers the case
            # where that first revert call failed)
            revert_desc = await self._revert(exp, service)
            log.append(f"REVERT: {revert_desc}")
            self.clear_active_fault()
            self.metrics.active_faults.labels(exp.fault.type, service or exp.fault.selector.zone or "region").dec()
            await self.post_annotation(f"chaos:{exp.id} REVERT", ["chaos", exp.fault.type])

            if self._abort_event.is_set():
                # emergency stop: end the run now rather than spending up to
                # another 5 minutes measuring recovery of an aborted run
                run.status, run.result = "aborted", "fail"
                return run

            # MeasureRecovery. Measuring only after the revert would make MTTR
            # at least the fault duration even when nothing broke, or when
            # the system healed itself (e.g. a restarted container) mid-fault.
            if run.tDetect is None:
                log.append("NO IMPACT: steady state held for the whole fault window (no MTTD/MTTR to measure)")
                recovered = True
            elif run.tRecover is not None:
                log.append(f"RECOVERED during the fault at +{run.mttrSeconds:.1f}s (self-healed before revert)")
                recovered = True
            else:
                recovered_at = await self._measure_recovery(exp, t0)
                if recovered_at is not None:
                    run.tRecover = recovered_at
                    run.mttrSeconds = recovered_at - t0
                    log.append(f"RECOVERED after revert at +{run.mttrSeconds:.1f}s")
                else:
                    log.append("did NOT recover within timeout")
                recovered = recovered_at is not None

            run.status = "aborted" if aborted else "pass"
            run.result = "fail" if (aborted or not recovered) else "pass"
            await self.post_annotation(f"chaos:{exp.id} RECOVERED mttr={run.mttrSeconds}", ["chaos", "recovery"])
            return run
        except Exception as e:
            log.append(f"ERROR: {e!r}")  # repr: some httpx errors stringify to ""
            run.status, run.result = "fail", "fail"
            try:
                # not just `if service:` because az_blackhole/region_failure
                # have no target service but still need reverting
                if self.find_orphaned_fault():
                    await self._revert(exp, service)
                self.clear_active_fault()
            except Exception:
                pass
            return run
        finally:
            self._active_run = None
            self._revert_fn = None
            self._runs[run.runId] = run
            self._save_runs()
            self.metrics.runs_total.labels(exp.id, run.result).inc()

    async def _inject(self, exp: ExperimentDefinition, service: str | None) -> str:
        f = exp.fault
        if f.type == "pod_kill":
            return await self.backend.pod_kill(service, f.count)
        if f.type == "cpu_hog":
            return await self.backend.cpu_hog(service, int(parse_duration(exp.duration)))
        if f.type == "oom":
            return await self.backend.oom(service)
        if f.type == "dependency_failure":
            return await self.backend.dependency_failure(service)
        if f.type == "network_latency":
            return await self.backend.network_latency(service, f.params.get("delay_ms", 300))
        if f.type == "packet_loss":
            return await self.backend.packet_loss(service, f.params.get("loss_percent", 20))
        if f.type == "az_blackhole":
            return await self.backend.az_blackhole(exp.fault.selector.zone or "unknown")
        if f.type == "region_failure":
            return await self.backend.region_failure()
        raise ValueError(f"unknown fault type {f.type}")

    async def _revert(self, exp: ExperimentDefinition, service: str | None) -> str:
        f = exp.fault
        if f.type in ("pod_kill", "oom"):
            return await self.backend.revert_pod_kill(service)
        if f.type == "cpu_hog":
            return await self.backend.revert_cpu_hog(service)
        if f.type == "dependency_failure":
            return await self.backend.revert_dependency_failure(service)
        if f.type in ("network_latency", "packet_loss"):
            return await self.backend.revert_network_fault(service)
        if f.type == "az_blackhole":
            return await self.backend.revert_az_blackhole(exp.fault.selector.zone or "unknown")
        if f.type == "region_failure":
            return await self.backend.revert_region_failure()
        return "no-op"

    async def _monitor(self, exp: ExperimentDefinition, run: RunResult, duration_s: float, stable_for: float = 30) -> bool:
        start = time.time()
        detected = False
        breach_since: float | None = None
        stable_since: float | None = None
        while time.time() - start < duration_s:
            holds, failing = await self.steady_state_holds(exp.steady_state)
            if not holds and not detected:
                run.tDetect = time.time()
                run.mttdSeconds = run.tDetect - run.t0
                run.log.append(f"t_detect=+{run.mttdSeconds:.1f}s steady state breached ({failing})")
                detected = True
            # self-healing while the fault is still active (same stability
            # rule as _measure_recovery: steady for stable_for seconds)
            if detected and run.tRecover is None:
                if holds:
                    stable_since = stable_since or time.time()
                    if time.time() - stable_since >= stable_for:
                        run.tRecover = stable_since
                        run.mttrSeconds = stable_since - run.t0
                else:
                    stable_since = None
            for cond in exp.abort_conditions:
                try:
                    r = await self._http.get(f"{PROMETHEUS_URL}/api/v1/query", params={"query": "rideflow:error_rate"})
                    result = r.json()["data"]["result"]
                    err_rate = float(result[0]["value"][1]) if result else 0.0
                except Exception:
                    err_rate = 0.0
                if compare(err_rate, cond.operator, cond.threshold):
                    if breach_since is None:
                        breach_since = time.time()
                    elif time.time() - breach_since >= parse_duration(cond.sustained_for):
                        run.log.append("ABORT CONDITION HIT — emergency revert")
                        self.metrics.abort_total.labels(exp.id, "error_rate").inc()
                        return True
                else:
                    breach_since = None
            # sleep 2s between polls, but wake immediately on /abort
            try:
                await asyncio.wait_for(self._abort_event.wait(), timeout=2)
            except asyncio.TimeoutError:
                continue
            return True
        return False

    async def _measure_recovery(self, exp: ExperimentDefinition, t0: float, timeout: float = 300, stable_for: float = 30) -> float | None:
        stable_since = None
        deadline = time.time() + timeout
        while time.time() < deadline:
            holds, _ = await self.steady_state_holds(exp.steady_state)
            if holds:
                stable_since = stable_since or time.time()
                if time.time() - stable_since >= stable_for:
                    return stable_since
            else:
                stable_since = None
            await asyncio.sleep(1)
        return None

    async def recover_orphaned_fault(self, experiments: dict) -> str:
        """Called once at startup. Unlike /abort (which uses the in-memory
        _revert_fn from the live run), this reconstructs the revert purely
        from the persisted state file + the reloaded experiment definitions,
        because a process that crashed mid-fault has no in-memory lambda
        left to call — that's the actual crash-recovery case, and the
        generic abort_all() alone cannot handle it."""
        orphan = self.find_orphaned_fault()
        if not orphan:
            return "no orphaned fault found"
        exp = experiments.get(orphan["experimentId"])
        if not exp:
            self.clear_active_fault()
            return (f"orphaned fault from run {orphan['runId']} referenced experiment "
                    f"{orphan['experimentId']!r} which is no longer loaded — cleared the "
                    f"record but could NOT auto-revert; check the target manually")
        service = None
        if exp.fault.selector.labelSelector:
            service = target_service_from_selector(exp.fault.selector.labelSelector)
        try:
            desc = await self._revert(exp, service)
        except Exception as e:
            return f"FAILED to auto-revert orphaned fault from run {orphan['runId']}: {e} — revert manually, see docs/runbooks/chaos-abort.md"
        self.clear_active_fault()
        run = self._runs.get(orphan["runId"])
        if run and run.status == "running":
            run.status, run.result = "aborted", "fail"
            run.log.append(f"process restarted mid-fault; auto-reverted on startup: {desc}")
            self._save_runs()
        return f"auto-reverted orphaned fault from run {orphan['runId']}: {desc}"

    async def abort_all(self, experiments: dict | None = None) -> str:
        run = self._active_run
        if run:
            # signal the run coroutine so it stops at its next check (the
            # monitor loop wakes immediately) instead of carrying on to "pass"
            self._abort_event.set()
            run.log.append("ABORTED by operator")
            self.metrics.abort_total.labels(run.experimentId, "operator").inc()
            if self._revert_fn:
                # revert right now rather than waiting for the run loop to
                # wake, since this is the emergency path
                try:
                    desc = await self._revert_fn()
                except Exception as e:
                    # the run loop is already signalled and retries the revert
                    # itself, so report this rather than failing the request
                    run.log.append(f"emergency REVERT failed: {e!r}")
                    return f"stopped run {run.runId} but its immediate revert failed ({e!r}); the run is retrying the revert"
                run.log.append(f"emergency REVERT: {desc}")
                return f"stopped run {run.runId} and reverted its fault: {desc}"
            return f"stopped run {run.runId} before any fault was injected"
        if self.find_orphaned_fault():
            # no live run but a fault record exists: reconstruct and revert it
            # the way startup crash-recovery does, instead of only deleting
            # the record and leaving the fault in place
            return await self.recover_orphaned_fault(experiments or {})
        return "no active fault to revert"

    def get_run(self, run_id: str) -> RunResult | None:
        return self._runs.get(run_id)

    def list_runs(self) -> list[RunResult]:
        return sorted(self._runs.values(), key=lambda r: r.t0 or 0, reverse=True)
