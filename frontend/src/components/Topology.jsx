// Live service map: node colour = health, amber ring = current fault target,
// red dashed edge = open circuit breaker, moving dashes = live traffic.

const NODES = {
  client: { x: 60, y: 160, label: "Clients", sub: "riders", round: true },
  "api-gateway": { x: 230, y: 160, label: "api-gateway", sub: "Go · :8080" },
  "user-service": { x: 440, y: 55, label: "user-service", sub: "Node.js · :8081" },
  "ride-service": { x: 440, y: 160, label: "ride-service", sub: "Python · :8082" },
  "driver-service": { x: 440, y: 265, label: "driver-service", sub: "Go · :8083" },
  "pricing-service": { x: 650, y: 110, label: "pricing-service", sub: "Python · :8084" },
  redis: { x: 650, y: 265, label: "Redis", sub: "geo index", round: true },
};
const EDGES = [
  ["client", "api-gateway"], ["api-gateway", "user-service"], ["api-gateway", "ride-service"],
  ["api-gateway", "driver-service"], ["ride-service", "pricing-service"], ["ride-service", "driver-service"],
  ["driver-service", "redis"],
];

export function targetOf(experimentId) {
  if (!experimentId) return null;
  if (experimentId.startsWith("region")) return "api-gateway";
  return ["api-gateway", "user-service", "ride-service", "driver-service", "pricing-service"].find((s) => experimentId.includes(s)) || null;
}

export default function Topology({ health = {}, breakers = [], target, trafficOn }) {
  const openEdge = (a, b) => breakers.some((x) => x.service === a && x.dependency === b && x.state !== "closed");
  return (
    <svg viewBox="0 0 740 320" width="100%" style={{ display: "block", maxHeight: 340 }}>
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#3a4870" />
        </marker>
      </defs>
      {EDGES.map(([a, b]) => {
        const A = NODES[a]; const B = NODES[b];
        const broken = openEdge(a, b);
        const down = health[b] === false;
        return (
          <g key={a + b}>
            <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke="#1f2a44" strokeWidth="3" />
            <line x1={A.x} y1={A.y} x2={B.x} y2={B.y}
              stroke={broken || down ? "#f87171" : "#5b8cff"} strokeWidth="2" opacity={trafficOn || broken ? 0.9 : 0.35}
              className={trafficOn && !broken ? "flow" : ""} strokeDasharray={broken ? "4 5" : undefined} />
          </g>
        );
      })}
      {Object.entries(NODES).map(([id, n]) => {
        const h = id === "client" ? true : id === "redis" ? health["driver-service"] !== false : health[id];
        const stroke = h === false ? "#f87171" : h ? "#34d399" : "#3a4870";
        const isTarget = target === id;
        return (
          <g key={id} transform={`translate(${n.x}, ${n.y})`}>
            {isTarget && <circle r="58" fill="none" stroke="#fbbf24" strokeWidth="2" opacity="0.8"><animate attributeName="r" values="50;60;50" dur="1.6s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.9;0.3;0.9" dur="1.6s" repeatCount="indefinite" /></circle>}
            {n.round
              ? <circle r="34" className="arch-node" style={{ stroke }} strokeWidth="2" />
              : <rect x="-62" y="-27" width="124" height="54" rx="12" className="arch-node" style={{ stroke }} strokeWidth="2" />}
            <circle cx={n.round ? 24 : 52} cy={n.round ? -24 : -17} r="5" fill={stroke} />
            <text textAnchor="middle" y="-2" className="arch-label">{n.label}</text>
            <text textAnchor="middle" y="13" className="arch-sub">{n.sub}</text>
          </g>
        );
      })}
    </svg>
  );
}
