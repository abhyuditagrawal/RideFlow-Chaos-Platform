export const fmtNum = (x, d = 1) => (x == null || Number.isNaN(x) ? "—" : Number(x).toFixed(d));
export const fmtPct = (x, d = 2) => (x == null ? "—" : (x * 100).toFixed(d) + "%");
export const fmtMs = (x) => (x == null ? "—" : x >= 1000 ? (x / 1000).toFixed(2) + " s" : Math.round(x) + " ms");
export const fmtSecs = (x) => (x == null ? "—" : x < 60 ? x.toFixed(1) + " s" : `${Math.floor(x / 60)}m ${Math.round(x % 60)}s`);
export const fmtTime = (ts) => (ts ? new Date(ts * 1000).toLocaleTimeString() : "—");
export const fmtDateTime = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : "—");
export const fmtInr = (x) => (x == null ? "—" : "₹" + Number(x).toFixed(2));

export function timeAgo(ts) {
  if (!ts) return "—";
  const s = Date.now() / 1000 - ts;
  if (s < 60) return `${Math.max(0, Math.round(s))}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function downloadFile(name, content, type = "application/json") {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function toCsv(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
}
