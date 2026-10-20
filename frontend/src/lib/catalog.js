// Human-readable context for the YAML-defined experiments and attacks.

export const EXPERIMENTS = {
  "pod-kill-ride-service": {
    code: "E1", name: "Crash one ride-service instance", layer: "L3 · ReplicaSet",
    what: "Restarts a ride-service container mid-traffic, like a pod being killed.",
    expect: "The orchestrator brings it back; errors stay negligible.",
  },
  "pod-kill-ride-service-2of3": {
    code: "E2", name: "Crash 2 of 3 ride-service instances", layer: "L3 · ReplicaSet",
    what: "Kills most of the ride-service capacity at once.",
    expect: "Errors under 5%, full recovery inside 45 s.",
  },
  "cpu-hog-pricing-service": {
    code: "E3", name: "CPU overload on pricing-service", layer: "L4 · Autoscaler",
    what: "Saturates pricing-service so every quote gets slow.",
    expect: "Autoscaling adds capacity and p99 recovers inside 120 s.",
    localNote: "On Docker this is simulated with injected latency.",
  },
  "network-latency-driver-service": {
    code: "E4", name: "300 ms network delay to driver-service", layer: "L7 · Circuit breaker",
    what: "Slows every call to driver matching.",
    expect: "Circuit breaker opens; rides are created as PENDING_MATCH with no 5xx.",
  },
  "dependency-failure-pricing-service": {
    code: "E5", name: "Pricing-service goes down", layer: "L7 · Fallback",
    what: "Every pricing request fails.",
    expect: "Ride-service falls back to a cached fare. Bookings never fail.",
  },
  "az-blackhole-az-a": {
    code: "E6", name: "Lose an availability zone", layer: "L5 · Cluster autoscaler",
    what: "Drains every node in one data centre.",
    expect: "Replicas in other zones keep availability above 99%.",
    localNote: "Needs the multi-AZ Kubernetes deployment; a no-op on a single Docker host.",
  },
  "region-failure-primary": {
    code: "E7", name: "Primary region outage", layer: "L6 · DNS failover",
    what: "Marks the Mumbai region unhealthy.",
    expect: "Route 53 shifts traffic to Singapore inside 120 s.",
    localNote: "Needs the two-region AWS deployment; aborts on a single Docker host.",
  },
  "ride-service-outage": {
    code: "E10", name: "Full ride-service outage (drill)", layer: "Detection & recovery",
    what: "Every booking fails for 30 s. Nothing absorbs this one.",
    expect: "The engine detects the breach in seconds and times the return to steady state.",
  },
  "packet-loss-user-service": {
    code: "E8", name: "20% packet loss to user-service", layer: "L7 · Retries",
    what: "Drops a fifth of traffic to the user service.",
    expect: "Retries with jitter absorb it; errors stay under 2%.",
  },
};

export const FAULT_LABEL = {
  pod_kill: "Pod kill", cpu_hog: "CPU hog", network_latency: "Network latency", oom: "Out of memory",
  az_blackhole: "AZ blackhole", region_failure: "Region failure", dependency_failure: "Dependency failure",
  packet_loss: "Packet loss",
};

export const ATTACKS = {
  "auth-bruteforce-user-service": {
    name: "Password brute-force", category: "Authentication", owasp: "A07: Identification & Auth Failures",
    what: "25 wrong passwords against one account.",
    fix: "Lock or exponentially slow an account after N failed logins; alert on spikes.",
  },
  "rate-limit-pressure-gateway": {
    name: "Request flood", category: "Availability", owasp: "API4: Unrestricted Resource Consumption",
    what: "240-request burst at the API gateway from one client.",
    fix: "Per-client token bucket at the gateway (fixed: it was keyed on IP:port).",
  },
  "jwt-tampering-user-service": {
    name: "JWT token forgery", category: "Authentication", owasp: "A02: Cryptographic Failures",
    what: "alg:none, garbage signatures, edited payloads, and a token signed with the default secret.",
    fix: "Load JWT_SECRET from a secrets manager; never ship the development default.",
  },
  "injection-fuzz-ride-service": {
    name: "Injection fuzzing", category: "Input validation", owasp: "A03: Injection",
    what: "SQLi, XSS, command-injection and oversized payloads in ride fields.",
    fix: "Schema validation on every input; never echo stack traces.",
  },
  "idor-probe-ride-service": {
    name: "IDOR / broken access control", category: "Authorization", owasp: "A01: Broken Access Control",
    what: "Reads another user's ride and calls internal APIs directly.",
    fix: "Ownership check on every ride read; NetworkPolicy or mTLS between services.",
  },
  "internal-endpoint-recon": {
    name: "Internal endpoint recon", category: "Exposure", owasp: "A05: Security Misconfiguration",
    what: "Looks for admin and internal endpoints reachable from outside.",
    fix: "Only the gateway gets a load balancer; everything else stays cluster-internal.",
  },
};

export const LAYERS = [
  { id: "L1", mech: "Liveness probe", detects: "Hung process", time: "10–30 s", t: 20 },
  { id: "L2", mech: "Readiness probe", detects: "Unhealthy but alive", time: "5–15 s", t: 10 },
  { id: "L3", mech: "ReplicaSet controller", detects: "Missing pod", time: "1–5 s", t: 3 },
  { id: "L4", mech: "Horizontal Pod Autoscaler", detects: "Sustained CPU / RPS", time: "30–90 s", t: 60 },
  { id: "L5", mech: "Cluster Autoscaler", detects: "Unschedulable pods", time: "90–180 s", t: 135 },
  { id: "L6", mech: "Route 53 health check", detects: "Region down", time: "60–95 s", t: 78 },
  { id: "L7", mech: "Circuit breaker", detects: "Failing dependency", time: "1–10 s", t: 5 },
];

export const PLACES = [
  ["Gateway of India", 18.922, 72.8347], ["CST Station", 18.9398, 72.8355],
  ["Marine Drive", 18.944, 72.8232], ["Worli Sea Face", 19.0096, 72.815],
  ["Dadar", 19.0178, 72.8478], ["Bandra Station", 19.0544, 72.8406],
  ["BKC", 19.0662, 72.8654], ["Mumbai Airport T2", 19.0974, 72.8742],
  ["Powai Lake", 19.126, 72.905], ["Andheri", 19.1197, 72.8464],
  ["Juhu Beach", 19.0988, 72.8267], ["Goregaon", 19.1663, 72.8526],
  ["Malad", 19.1874, 72.8484], ["Ghatkopar", 19.086, 72.9081],
  ["Kurla", 19.0726, 72.8845], ["Lower Parel", 18.9953, 72.83],
].map(([name, lat, lng]) => ({ name, lat, lng }));

export const SERVICES = [
  { id: "api-gateway", lang: "Go", port: 8080, role: "Front door: routing, JWT, rate limiting" },
  { id: "user-service", lang: "Node.js", port: 8081, role: "Sign-up, login, JWT issuing" },
  { id: "ride-service", lang: "Python", port: 8082, role: "Ride lifecycle, circuit breakers" },
  { id: "driver-service", lang: "Go", port: 8083, role: "Geo index, driver matching" },
  { id: "pricing-service", lang: "Python", port: 8084, role: "Fares and surge" },
];

export const expInfo = (id) => EXPERIMENTS[id] || { code: "", name: id, layer: "", what: "", expect: "" };
export const atkInfo = (id) => ATTACKS[id] || { name: id, category: "", owasp: "", what: "", fix: "" };
