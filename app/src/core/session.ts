/**
 * Offline analysis of a recorded session: rebuild each sensor's sample stream from the
 * stored rows, filter it, align sensors on a shared 1 ms grid, and export CSV/JSON.
 * Same algorithm as the web app, so exports match.
 */
import { BANDS, Chain, ENV_WINDOW, type FilterSettings } from "./dsp";
import type { Calibration } from "./calibration";
import { PER_PACKET, ROW_BYTES, UV_PER_LSB } from "./protocol";

export interface SensorMeta {
  id: string;
  name: string;
  short: string;
  calibration?: Calibration | null;
}

export interface Marker {
  /** seconds since recording start */
  t: number;
  label: string;
}

export interface SessionMeta {
  id: string;
  name: string;
  notes: string;
  createdAt: string;
  filters: FilterSettings;
  sensors: SensorMeta[];
  app: { version: string; platform: string };
}

export interface SessionStatus {
  endedAt?: string;
  durationMs?: number;
  packets?: Record<string, number>;
}

export interface Series {
  meta: SensorMeta;
  packets: number;
  /** ms per packet on the recording clock (119 / sample rate in kHz) */
  slope: number;
  sampleRate: number;
  /** sample times, ms since recording start */
  t: Float64Array;
  uv: Float32Array;
  filt: Float32Array;
  env: Float32Array;
}

/** Stored rows for one sensor -> filtered sample stream with per-sample times. */
export function buildSeries(meta: SensorMeta, bytes: Uint8Array, filters: FilterSettings): Series | null {
  const n = Math.floor(bytes.length / ROW_BYTES);
  if (!n) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, n * ROW_BYTES);
  const seqs = new Float64Array(n), hosts = new Float64Array(n);
  let prev = -1, wraps = 0;
  for (let r = 0; r < n; r++) {
    const o = r * ROW_BYTES;
    const s = dv.getUint8(o + 9) | (dv.getUint8(o + 10) << 8) | (dv.getUint8(o + 11) << 16);
    if (prev >= 0 && s < prev && prev - s > 0x800000) wraps++;
    prev = s;
    seqs[r] = s + wraps * 0x1000000;
    hosts[r] = dv.getFloat64(o, true);
  }
  // sensor clock -> recording clock: least-squares slope of arrival time vs sequence,
  // offset from the lower envelope (packets arrive late, never early)
  let slope = PER_PACKET / 0.976;
  if (n > 50) {
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += seqs[i]; my += hosts[i]; }
    mx /= n; my /= n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (seqs[i] - mx) * (hosts[i] - my); sxx += (seqs[i] - mx) ** 2; }
    const fit = sxx ? sxy / sxx : slope;
    if (fit > PER_PACKET * 0.9 && fit < PER_PACKET * 1.1) slope = fit;
  }
  let offset = Infinity;
  for (let i = 0; i < n; i++) offset = Math.min(offset, hosts[i] - slope * seqs[i]);

  const total = n * PER_PACKET, step = slope / PER_PACKET;
  const t = new Float64Array(total), uv = new Float32Array(total), filt = new Float32Array(total), env = new Float32Array(total);
  const chain = new Chain(filters, 1000 / step);
  let k = 0;
  for (let r = 0; r < n; r++) {
    const o = r * ROW_BYTES + 8;
    if (r > 0 && seqs[r] !== seqs[r - 1] + 1) chain.reset(); // lost packets
    const tLast = offset + slope * seqs[r];
    let empty = true;
    for (let i = 0; i < PER_PACKET; i++) if (dv.getUint16(o + 6 + i * 2, true) !== 8192) { empty = false; break; }
    for (let i = 0; i < PER_PACKET; i++, k++) {
      t[k] = tLast - (PER_PACKET - 1 - i) * step;
      if (empty) { uv[k] = filt[k] = env[k] = NaN; continue; } // battery-measurement packet
      const x = (dv.getUint16(o + 6 + i * 2, true) - 8192) * UV_PER_LSB;
      chain.step(x);
      uv[k] = x; filt[k] = chain.filtered; env[k] = chain.envelope;
    }
    if (empty) chain.reset();
  }
  return { meta, packets: n, slope, sampleRate: (1000 * PER_PACKET) / slope, t, uv, filt, env };
}

export interface Grid {
  tMin: number;
  length: number;
  /** per series: grid cell -> sample index (-1 = none) */
  index: Int32Array[];
}

/** Place every series on a shared 1 ms grid starting at the recording start. */
export function alignGrid(series: Series[]): Grid {
  if (!series.length) return { tMin: 0, length: 0, index: [] };
  let tMin = Infinity, tMax = -Infinity;
  for (const s of series) { tMin = Math.min(tMin, s.t[0]); tMax = Math.max(tMax, s.t[s.t.length - 1]); }
  tMin = Math.max(0, Math.floor(tMin)); // drop samples captured before Record was pressed
  const length = Math.max(0, Math.ceil(tMax - tMin) + 1);
  const index = series.map((s) => {
    const gi = new Int32Array(length).fill(-1);
    for (let k = 0; k < s.t.length; k++) {
      const idx = Math.round(s.t[k] - tMin);
      if (idx >= 0 && idx < length && gi[idx] < 0) gi[idx] = k;
    }
    // a ~975 Hz stream leaves single empty cells on a 1 kHz grid; fill them from the neighbour
    for (let i = 1; i < length - 1; i++) if (gi[i] < 0 && gi[i - 1] >= 0 && gi[i + 1] >= 0 && gi[i + 1] - gi[i - 1] <= 1) gi[i] = gi[i - 1];
    return gi;
  });
  return { tMin, length, index };
}

const fmt = (v: number, d = 2) => (v === v ? v.toFixed(d) : "");

export function csvHeader(series: Series[]): string {
  const cols = ["time_s"];
  for (const s of series) {
    cols.push(`${s.meta.short}_raw_uV`, `${s.meta.short}_filtered_uV`, `${s.meta.short}_envelope_uV`);
    if (s.meta.calibration?.mvcRms) cols.push(`${s.meta.short}_pct_mvc`);
  }
  cols.push("marker");
  return cols.join(",");
}

/** Stream the CSV in chunks (rows with no data and no marker are skipped). */
export function writeCsv(series: Series[], grid: Grid, markers: Marker[], write: (chunk: string) => void, chunkRows = 20000) {
  const { tMin, length, index } = grid;
  const byCell = new Map<number, string>();
  for (const m of markers) {
    const idx = Math.max(0, Math.min(length - 1, Math.round(m.t * 1000 - tMin)));
    byCell.set(idx, byCell.has(idx) ? byCell.get(idx) + "; " + m.label : m.label);
  }
  write(csvHeader(series) + "\n");
  let lines: string[] = [];
  for (let i = 0; i < length; i++) {
    let line = ((tMin + i) / 1000).toFixed(3);
    let any = false;
    for (let j = 0; j < series.length; j++) {
      const s = series[j], k = index[j][i];
      const r = k >= 0 ? s.uv[k] : NaN, f = k >= 0 ? s.filt[k] : NaN, e = k >= 0 ? s.env[k] : NaN;
      if (r === r) any = true;
      line += "," + fmt(r) + "," + fmt(f) + "," + fmt(e);
      const mvc = s.meta.calibration?.mvcRms;
      if (mvc) line += "," + fmt((e / mvc) * 100, 1);
    }
    const mk = byCell.get(i);
    if (!any && !mk) continue;
    line += "," + (mk ? `"${mk.replace(/"/g, '""')}"` : "");
    lines.push(line);
    if (lines.length >= chunkRows) { write(lines.join("\n") + "\n"); lines = []; }
  }
  if (lines.length) write(lines.join("\n") + "\n");
}

export function metaJson(meta: SessionMeta, status: SessionStatus, markers: Marker[], series: Series[], filters: FilterSettings) {
  const band = BANDS[filters.band];
  return {
    name: meta.name,
    notes: meta.notes,
    createdAt: meta.createdAt,
    endedAt: status.endedAt ?? null,
    durationSeconds: +(sessionDurationMs(status, series) / 1000).toFixed(3),
    gridHz: 1000,
    units: "microvolts (MYOblue_GUI scale: (raw - 8192) * 0.30518)",
    timeBase: "seconds since recording start, 1 ms rows; each sample is placed at its own time from the sensor's clock (fitted to packet arrival times)",
    filters: { preset: band.id, label: band.label, highPassHz: band.hp, lowPassHz: band.lp ?? null, notchHz: filters.notch || null, envelope: `moving RMS, ${ENV_WINDOW} samples` },
    sensors: series.map((s) => ({
      column: s.meta.short, name: s.meta.name, id: s.meta.id, packets: s.packets,
      measuredSampleRateHz: +s.sampleRate.toFixed(2), calibration: s.meta.calibration ?? null,
    })),
    markers,
    app: meta.app,
  };
}

export function sessionDurationMs(status: SessionStatus, series: Series[]): number {
  if (status.durationMs) return status.durationMs;
  let end = 0;
  for (const s of series) end = Math.max(end, s.t[s.t.length - 1] ?? 0);
  return end;
}

/* ---- analysis helpers for the session screen ---- */

/** First sample index with t >= x (binary search). */
export function lowerBound(t: Float64Array, x: number): number {
  let lo = 0, hi = t.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (t[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Per-column min/max of `values` between times [t0, t1) ms. */
export function columnsInRange(s: Series, values: Float32Array, t0: number, t1: number, cols: number) {
  const mins = new Float32Array(cols).fill(NaN), maxs = new Float32Array(cols).fill(NaN);
  let lo = Infinity, hi = -Infinity;
  const a = lowerBound(s.t, t0), b = lowerBound(s.t, t1), span = t1 - t0;
  for (let k = a; k < b; k++) {
    const v = values[k];
    if (v !== v) continue;
    const c = Math.min(cols - 1, Math.floor(((s.t[k] - t0) / span) * cols));
    if (!(mins[c] <= v)) mins[c] = v;
    if (!(maxs[c] >= v)) maxs[c] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { mins, maxs, lo, hi };
}

export interface SegmentStats {
  label: string;
  start: number; // s
  end: number; // s
  perSensor: { short: string; meanEnv: number; peakEnv: number; meanPct: number | null; peakPct: number | null; activePct: number | null }[];
}

/** Stats for each stretch between markers ("start" until the first marker). */
export function segmentStats(series: Series[], markers: Marker[], durationS: number): SegmentStats[] {
  const ms = [...markers].sort((a, b) => a.t - b.t);
  const bounds: { label: string; start: number; end: number }[] = [];
  let prevT = 0, prevLabel = "start";
  for (const m of ms) {
    if (m.t > prevT + 0.05) bounds.push({ label: prevLabel, start: prevT, end: m.t });
    prevT = m.t; prevLabel = m.label;
  }
  if (durationS > prevT + 0.05) bounds.push({ label: prevLabel, start: prevT, end: durationS });
  return bounds.map((b) => ({
    ...b,
    perSensor: series.map((s) => {
      const a = lowerBound(s.t, b.start * 1000), z = lowerBound(s.t, b.end * 1000);
      const vals: number[] = [];
      let sum = 0, active = 0;
      const cal = s.meta.calibration;
      for (let k = a; k < z; k++) {
        const e = s.env[k];
        if (e !== e) continue;
        vals.push(e); sum += e;
        if (cal && e > cal.threshold) active++;
      }
      const mean = vals.length ? sum / vals.length : NaN;
      vals.sort((x, y) => x - y);
      const peak = vals.length ? vals[Math.floor(0.98 * (vals.length - 1))] : NaN;
      return {
        short: s.meta.short,
        meanEnv: mean,
        peakEnv: peak,
        meanPct: cal ? (mean / cal.mvcRms) * 100 : null,
        peakPct: cal ? (peak / cal.mvcRms) * 100 : null,
        activePct: cal && vals.length ? (100 * active) / vals.length : null,
      };
    }),
  }));
}

export function fileBase(meta: SessionMeta): string {
  const d = new Date(meta.createdAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const slug = meta.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "recording";
  return `myoblue_${stamp}_${slug}`;
}
