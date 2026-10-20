# RideFlow — Self-Healing Multi-Region Microservices Platform with Chaos Engineering & Security Testing

A ride-hailing backend (5 polyglot microservices) with two purpose-built
engines running against it: a **chaos injector** that breaks things on
purpose and measures recovery, and a **security attack simulator** that
red-teams the app's own auth, input handling, and access control — both
driven from one live dashboard. Full spec: [RideFlow-Chaos-Platform-Documentation.md](RideFlow-Chaos-Platform-Documentation.md).

## 15-minute quickstart (local, no cloud account needed)

Requires Docker + Docker Compose.

```bash
make up          # builds and starts everything
```

This starts 11 containers, including a built-in **traffic simulator** (riders
booking rides plus a fleet of 30 drivers moving around Mumbai), so the
platform has live load from the first minute.

| Thing | URL |
|---|---|
| **Mission Control dashboard** (React) | http://localhost:5173 |
| API (via api-gateway) | http://localhost:8080 |
| Chaos injector control API | http://localhost:9000 |
| Security attack simulator API | http://localhost:9001 |
| Grafana (admin/admin, anonymous viewer enabled) | http://localhost:3001 |
| Prometheus | http://localhost:9090 |

The dashboard has seven pages:

| Page | What it does |
|---|---|
| Mission Control | Live KPIs with sparklines, service topology (health, fault target, open breakers), traffic chart, security score, fleet map |
| Ride App | Sign up / log in (JWT), book rides on a live map, watch them get matched, cancel; platform-wide ride feed |
| Chaos Lab | Experiment catalogue, live run tracker (phases, MTTD/MTTR, metrics), emergency abort, kill switch, game-day scheduler, traffic simulator, MTTD/MTTR charts, run history |
| Security Lab | Posture gauge, one-click full sweep, OWASP-mapped attack catalogue with fixes, findings explorer, history |
| Observability | Steady-state check, throughput/latency charts (5/15/60 min), per-service RED metrics, live circuit breakers |
| Reports | Overall grade, resilience + security scorecards, CSV/JSON export, print to PDF, clear history |
| Architecture | Diagrams, request flow, self-healing layers, deployment, decisions |

To work on the dashboard itself: `cd frontend && npm install && npm run dev`
(http://localhost:5174, proxies to the running compose stack).

Smoke test the API:

```bash
curl -X POST localhost:8080/v1/rides \
  -H 'Content-Type: application/json' \
  -d '{"userId":"demo","pickup":{"lat":19.076,"lng":72.877},"drop":{"lat":19.119,"lng":72.846}}'
```

Generate load and watch Grafana move:

```bash
make load-test          # steady 200 RPS, k6
```

Run a chaos experiment and watch it recover, live, in the dashboard:

```bash
make chaos-demo         # pod-kill-ride-service via the injector API
```

Run `make load-test` in a second terminal *before* `make chaos-demo` — the
p99-latency steady-state condition reads as `NaN` (and therefore "breached")
when there's no traffic to compute a histogram quantile from, which produces
a misleadingly instant MTTD if the system is idle.

Or drive it from the dashboard at http://localhost:5173 — pick an experiment,
hit **Run experiment**, watch service health, MTTD/MTTR, and the live log
update every 2 seconds. The red **EMERGENCY ABORT** button reverts any active
fault immediately (doc §8.5 safety controls).

Run a security attack and see what it finds:

```bash
curl -X POST localhost:9001/attacks/jwt-tampering-user-service/run
```

Or from the dashboard's **Security Testing** tab — pick an attack, run it,
and read the findings (each one says whether the app defended correctly or
whether a real weakness was found, with a plain-English explanation). See
[docs/security/baseline-findings.md](docs/security/baseline-findings.md) for
the first full run's results — it already found and led to fixing one real
bug (the gateway's rate limiter wasn't actually keying on client IP correctly).

Tear down (always run this — see cost discipline below):

```bash
make down
```

## Repository layout

```
services/          # api-gateway (Go), user-service (Node), ride-service (Python),
                    # driver-service (Go), pricing-service (Python)
chaos-injector/     # fault injection + MTTD/MTTR measurement engine, dual backend (K8s / local docker)
security-injector/  # authorized attack simulator — auth brute-force, JWT tampering,
                    # injection fuzzing, IDOR/access-control probing, recon, DoS-pressure testing
attacks/            # the 6 security attack definitions (mirrors experiments/)
frontend/           # Mission Control dashboard: React + Vite, served by nginx (compose) or Vercel
api/                # Vercel serverless proxy (Node.js): auth, backend routing, SSRF guard
infra/              # Terraform — VPC, EKS, Redis, DynamoDB, Route 53, per §7
deploy/helm/        # umbrella Helm chart — Deployments/HPA/PDB/Ingress per §9.2
observability/      # Prometheus recording/alert rules, Grafana provisioning
dashboards/         # Grafana dashboard JSON (Platform Overview, Chaos Timeline, Recovery Analysis)
loadtest/           # k6 scripts
experiments/        # the 9 chaos experiment definitions (E1–E9) from §13.2
docs/api/           # service contracts (ports, endpoints, env vars — read this first)
docs/adr/           # architecture decision records
docs/runbooks/      # deploy, rollback, failover, chaos-abort, teardown
.github/workflows/  # CI (lint/build/scan) + CD (build→deploy-primary→resilience-gate→deploy-secondary)
```

## Hosting the dashboard on Vercel

The dashboard can be deployed straight from GitHub to Vercel, with the backend
running elsewhere (e.g. the free-tier EC2 box). See [DEPLOY-VERCEL.md](DEPLOY-VERCEL.md).

## Running on real AWS

The Terraform in `infra/` is written to be applied, but **nothing here provisions
cloud resources automatically** — that's a deliberate choice given the cost risk
the spec itself calls out (§14, §15 risk #1). To deploy for real:

1. Read `infra/README.md` for apply order (global → primary → secondary) and
   the hard budget-alarm setup — do this *first*, before `terraform apply`.
2. `cd infra/global && terraform init && terraform apply`
3. `cd infra/envs/primary && terraform init && terraform apply`
4. `helm upgrade --install rideflow deploy/helm/rideflow -n rideflow --create-namespace`
5. Repeat 3–4 for `envs/secondary` with `-f deploy/helm/values-secondary.yaml`.

Cost-optimised operating model (§14.2): spot instances, scheduled teardown,
single NAT gateway. Realistic project-lifetime cost with discipline: **$60–100
total**, not $460/month. `make down` (or the daily EventBridge scale-to-zero
rule once deployed) is not optional — ALBs and NAT Gateways bill hourly whether
or not anything is running.

## What to actually read first

1. `docs/api/contracts.md` — ports, service names, env vars. Nothing else makes
   sense without this.
2. `chaos-injector/app/engine.py` — the hypothesis-first fault injection and
   MTTD/MTTR measurement loop. This is the project's real contribution;
   everything else is standard cloud-native plumbing around it.
3. `RideFlow-Chaos-Platform-Documentation.md` §9.1 — the layered self-healing
   table. This is the intellectual core of the report: recovery time is
   inversely proportional to the recovery layer's proximity to the fault.

## Showcase features beyond the base spec

- **Security attack simulator** (`security-injector/`) — a second engine,
  architecturally mirroring the chaos injector, that red-teams RideFlow's
  own auth, JWT handling, input validation, and access control. It only
  ever targets this app's own services (hardcoded, not parameterized) —
  authorized self-testing, not a general-purpose attack tool. It already
  found and led to fixing a real bug: see
  [docs/security/baseline-findings.md](docs/security/baseline-findings.md).
- **Live Mission Control dashboard** (`frontend/dist/index.html`,
  http://localhost:5173) — four tabs: Overview (topology, live RPS/error-
  rate/p99, service health, security posture score), Chaos Engineering,
  Security Testing (attack catalogue, findings, run history), and Live Logs.
  Doesn't require a Grafana login to demo from a laptop or projector.
- **Dual-backend chaos injector** — the same fault catalogue, experiment
  schema, and measurement engine run identically against a real Kubernetes
  cluster *or* the local docker-compose stack (`chaos-injector/app/backends.py`).
  This means the entire chaos story — pod kill, dependency failure, latency
  injection, region failover — is demoable with nothing but `docker compose up`,
  which matters a great deal when you're standing in front of examiners with
  no AWS budget left.
- **Crash-safe fault state** — the injector persists the currently-active
  fault to disk and auto-reverts it on restart if it finds one orphaned
  (doc §8.5's "auto-revert on crash" control, actually implemented, not just
  specified).
