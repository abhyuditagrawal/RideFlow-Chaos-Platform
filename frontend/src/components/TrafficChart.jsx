import { Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtMs, fmtNum, fmtPct } from "../lib/format";
import { ChartTooltip } from "./ui";

const tick = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export default function TrafficChart({ points = [], height = 300, series = ["rps", "p99Ms"] }) {
  const hasErr = series.includes("errorRate");
  // error rate (0-1) and latency (ms) can't share an axis
  const latOnLeft = hasErr || !(series.includes("rps") || series.includes("ridesPerMin"));
  const latAxis = latOnLeft ? "l" : "r";
  const formatters = { rps: (v) => fmtNum(v, 2) + " rps", p99Ms: fmtMs, p50Ms: fmtMs, errorRate: fmtPct, ridesPerMin: (v) => fmtNum(v, 1) + "/min" };
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={points} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
        <defs>
          <linearGradient id="g-rps" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5b8cff" stopOpacity={0.45} />
            <stop offset="100%" stopColor="#5b8cff" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="g-rides" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d399" stopOpacity={0.4} />
            <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="g-err" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f87171" stopOpacity={0.45} />
            <stop offset="100%" stopColor="#f87171" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 4" vertical={false} />
        <XAxis dataKey="t" tickFormatter={tick} minTickGap={40} tickLine={false} axisLine={false} />
        <YAxis yAxisId="l" tickLine={false} axisLine={false} width={50}
          tickFormatter={latOnLeft ? (v) => Math.round(v) + "ms" : undefined} />
        <YAxis yAxisId="r" orientation="right" tickLine={false} axisLine={false} width={50}
          tickFormatter={hasErr ? (v) => (v * 100).toFixed(1).replace(/\.0$/, "") + "%" : (v) => Math.round(v) + "ms"} />
        <Tooltip content={<ChartTooltip formatLabel={(t) => new Date(t * 1000).toLocaleTimeString()} formatters={formatters} />} />
        <Legend iconType="circle" iconSize={8} />
        {series.includes("rps") && <Area yAxisId="l" type="monotone" dataKey="rps" name="Requests/s" stroke="#5b8cff" strokeWidth={2} fill="url(#g-rps)" isAnimationActive={false} connectNulls />}
        {series.includes("ridesPerMin") && <Area yAxisId="l" type="monotone" dataKey="ridesPerMin" name="Rides/min" stroke="#34d399" strokeWidth={2} fill="url(#g-rides)" isAnimationActive={false} connectNulls />}
        {series.includes("p99Ms") && <Line yAxisId={latAxis} type="monotone" dataKey="p99Ms" name="p99 latency" stroke="#a78bfa" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />}
        {series.includes("p50Ms") && <Line yAxisId={latAxis} type="monotone" dataKey="p50Ms" name="p50 latency" stroke="#22d3ee" strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />}
        {series.includes("errorRate") && <Area yAxisId="r" type="monotone" dataKey="errorRate" name="Error rate" stroke="#f87171" strokeWidth={2} fill="url(#g-err)" isAnimationActive={false} connectNulls />}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
