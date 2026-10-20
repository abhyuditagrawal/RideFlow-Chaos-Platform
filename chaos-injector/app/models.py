"""Experiment definition schema — mirrors doc §8.3 exactly."""
from typing import Literal

from pydantic import BaseModel


class SteadyStateCondition(BaseModel):
    metric: str
    operator: Literal["<", ">", "<=", ">=", "=="]
    threshold: float


class Selector(BaseModel):
    namespace: str = "rideflow"
    labelSelector: str | None = None
    zone: str | None = None  # for az_blackhole


class Fault(BaseModel):
    type: Literal[
        "pod_kill", "cpu_hog", "network_latency", "oom",
        "az_blackhole", "region_failure", "dependency_failure", "packet_loss",
    ]
    selector: Selector
    count: int = 1
    params: dict = {}


class BlastRadius(BaseModel):
    max_pods_affected: int = 1
    max_percent_of_replicas: int = 34
    forbidden_namespaces: list[str] = ["kube-system", "observability", "chaos"]


class AbortCondition(BaseModel):
    metric: Literal["error_rate"] = "error_rate"
    operator: str = ">"
    threshold: float = 0.25
    sustained_for: str = "15s"


class ExperimentDefinition(BaseModel):
    id: str
    description: str
    fault: Fault
    steady_state: list[SteadyStateCondition]
    blast_radius: BlastRadius = BlastRadius()
    duration: str = "120s"
    abort_conditions: list[AbortCondition] = [AbortCondition()]
    hypothesis: str | None = None
    runs_required: int = 1


class RunResult(BaseModel):
    runId: str
    experimentId: str
    status: Literal["running", "pass", "fail", "aborted"]
    dryRun: bool = False
    t0: float | None = None
    tDetect: float | None = None
    tAction: float | None = None
    tRecover: float | None = None
    mttdSeconds: float | None = None
    mttrSeconds: float | None = None
    result: Literal["pass", "fail", "unknown"] = "unknown"
    log: list[str] = []
