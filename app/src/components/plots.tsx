/** Signal plots drawn with react-native-svg from min/max columns (fast enough at ~12 fps). */
import React, { useEffect, useState } from "react";
import { AccessibilityInfo, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Line, Path, Rect, Text as SvgText } from "react-native-svg";
import { spectrum as fft, FFT_N } from "../core/dsp";
import type { LiveSensor } from "../lib/sensors";
import { RING } from "../lib/sensors";
import type { Settings } from "../lib/settings";
import { useTheme, uvLabel } from "../lib/theme";

let reduceMotion = false;
AccessibilityInfo.isReduceMotionEnabled().then((v) => { reduceMotion = v; }).catch(() => {});
AccessibilityInfo.addEventListener("reduceMotionChanged", (v) => { reduceMotion = v; });

/** Re-render every `ms` (at most once a second when the system asks for reduced motion). */
export function useTick(ms: number) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), reduceMotion ? Math.max(ms, 1000) : ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}

export function useWidth(): [number, (e: LayoutChangeEvent) => void] {
  const [w, setW] = useState(0);
  return [w, (e) => setW(Math.round(e.nativeEvent.layout.width))];
}

export interface Columns { mins: Float32Array; maxs: Float32Array; lo: number; hi: number }

/** Min/max per column of the newest n samples of a ring buffer. */
export function ringColumns(buf: Float32Array, w: number, n: number, cols: number): Columns {
  const start = (w - n + RING) % RING, per = n / cols;
  const mins = new Float32Array(cols).fill(NaN), maxs = new Float32Array(cols).fill(NaN);
  let lo = Infinity, hi = -Infinity;
  for (let x = 0; x < cols; x++) {
    let mn = Infinity, mx = -Infinity;
    const a = Math.floor(x * per), b = Math.floor((x + 1) * per);
    for (let i = a; i < b; i++) { const v = buf[(start + i) % RING]; if (v === v) { if (v < mn) mn = v; if (v > mx) mx = v; } }
    if (mn !== Infinity) { mins[x] = mn; maxs[x] = mx; if (mn < lo) lo = mn; if (mx > hi) hi = mx; }
  }
  return { mins, maxs, lo, hi };
}

/** SVG path through per-column min/max (breaks at gaps). */
export function columnsPath(c: Columns, Y: (v: number) => number, xScale = 1): string {
  let d = "", pen = false;
  for (let x = 0; x < c.mins.length; x++) {
    const mn = c.mins[x], mx = c.maxs[x];
    if (mn !== mn) { pen = false; continue; }
    const px = (x * xScale).toFixed(1);
    d += (pen ? "L" : "M") + px + " " + Y(mn).toFixed(1);
    if (mx !== mn) d += "L" + px + " " + Y(mx).toFixed(1);
    pen = true;
  }
  return d;
}

export function envelopePath(maxs: Float32Array, Y: (v: number) => number, sign: 1 | -1, xScale = 1): string {
  let d = "", pen = false;
  for (let x = 0; x < maxs.length; x++) {
    const v = maxs[x];
    if (v !== v) { pen = false; continue; }
    d += (pen ? "L" : "M") + (x * xScale).toFixed(1) + " " + Y(sign * v).toFixed(1);
    pen = true;
  }
  return d;
}

export function yRange(s: LiveSensor | null, cal: LiveSensor["cal"], mode: Settings["viewMode"], scale: Settings["scale"], lo: number, hi: number): [number, number] {
  const envelope = mode === "envelope";
  let ymin: number, ymax: number;
  if (scale === "mvc" && cal) {
    ymax = envelope ? cal.mvcRms * 1.25 : cal.mvcRms * 3.5;
    ymin = envelope ? 0 : -ymax;
  } else if (scale !== "auto" && scale !== "hold" && scale !== "mvc") {
    ymax = +scale; ymin = envelope ? 0 : -ymax;
  } else if (lo === Infinity) { ymax = 50; ymin = envelope ? 0 : -50; }
  else if (envelope) { ymin = 0; ymax = Math.max(hi * 1.15, 10); }
  else if (mode === "raw") { const pad = Math.max((hi - lo) * 0.1, 5); ymin = lo - pad; ymax = hi + pad; }
  else { const m = Math.max(Math.abs(lo), Math.abs(hi), 10) * 1.15; ymin = -m; ymax = m; }
  if (s && (scale === "hold" || (scale === "mvc" && !cal))) {
    if (!s.hold || s.hold.key !== mode) s.hold = { key: mode, ymin, ymax };
    s.hold.ymin = Math.min(s.hold.ymin, ymin);
    s.hold.ymax = Math.max(s.hold.ymax, ymax);
    ymin = s.hold.ymin; ymax = s.hold.ymax;
  }
  return [ymin, ymax];
}

export function LivePlot({ sensor, settings, color, height = 170 }: { sensor: LiveSensor; settings: Settings; color: string; height?: number }) {
  const t = useTheme();
  const [W, onLayout] = useWidth();
  useTick(80);
  const cols = Math.max(1, Math.floor(W / 1.5));
  let body: React.ReactNode = null;
  if (W > 0) {
    const mode = settings.viewMode;
    const rate = sensor.rate > 500 ? sensor.rate : 975;
    const n = Math.min(RING, Math.round(settings.win * rate));
    const buf = mode === "raw" ? sensor.raw : mode === "envelope" ? sensor.env : sensor.filt;
    const c = ringColumns(buf, sensor.w, n, cols);
    const overlay = settings.overlay && mode === "filtered" ? ringColumns(sensor.env, sensor.w, n, cols) : null;
    const cal = sensor.cal;
    const [ymin, ymax] = yRange(sensor, cal, mode, settings.scale, c.lo, overlay ? Math.max(c.hi, overlay.hi) : c.hi);
    const top = 8, bottom = height - 8;
    const Y = (v: number) => bottom - ((Math.max(ymin, Math.min(ymax, v)) - ymin) / (ymax - ymin)) * (bottom - top);
    const xs = W / cols;
    const ticks = [];
    for (let sec = 1; sec < settings.win; sec++) ticks.push((W * sec) / settings.win);
    const tag = settings.scale === "hold" || (settings.scale === "mvc" && !cal) ? "peak hold · tap to reset" : settings.scale === "mvc" ? "scaled to MVC" : "";
    body = (
      <Svg width={W} height={height}>
        {ticks.map((x) => <Line key={x} x1={x} x2={x} y1={top} y2={bottom} stroke={t.grid} strokeWidth={1} />)}
        {ymin < 0 && ymax > 0 ? <Line x1={0} x2={W} y1={Y(0)} y2={Y(0)} stroke={t.grid} strokeWidth={1} /> : null}
        {mode === "envelope" && cal ? <Line x1={0} x2={W} y1={Y(cal.threshold)} y2={Y(cal.threshold)} stroke={t.muted} strokeDasharray="4 4" strokeWidth={1} /> : null}
        <Path d={columnsPath(c, Y, xs)} stroke={color} strokeWidth={1.3} fill="none" strokeOpacity={overlay ? 0.75 : 1} strokeLinejoin="round" />
        {overlay ? <Path d={envelopePath(overlay.maxs, Y, 1, xs)} stroke={t.ink} strokeWidth={1.6} fill="none" /> : null}
        {overlay ? <Path d={envelopePath(overlay.maxs, Y, -1, xs)} stroke={t.ink} strokeWidth={1.6} fill="none" /> : null}
        <SvgText x={8} y={18} fill={t.muted} fontSize={11}>{uvLabel(ymax)}</SvgText>
        {mode !== "envelope" ? <SvgText x={8} y={height - 10} fill={t.muted} fontSize={11}>{uvLabel(ymin)}</SvgText> : null}
        {tag ? <SvgText x={W - 8} y={18} fill={t.muted} fontSize={11} textAnchor="end">{tag}</SvgText> : null}
      </Svg>
    );
  }
  return <View onLayout={onLayout} style={{ height }}>{body}</View>;
}

export function SpectrumPlot({ sensor, source, color, height = 96 }: { sensor: LiveSensor; source: "raw" | "filtered"; color: string; height?: number }) {
  const t = useTheme();
  const [W, onLayout] = useWidth();
  const tick = useTick(300);
  const [mag, setMag] = useState<Float32Array | null>(null);
  useEffect(() => {
    const m = fft(source === "raw" ? sensor.raw : sensor.filt, sensor.w);
    setMag((prev) => (prev ? prev.map((v, i) => 0.6 * v + 0.4 * m[i]) : m));
  }, [tick, sensor, source]);
  let body: React.ReactNode = null;
  if (W > 0 && mag) {
    const rate = sensor.rate > 500 ? sensor.rate : 975, bins = mag.length;
    let peak = 1e-9, best = 2;
    for (let i = 2; i < bins; i++) { if (mag[i] > peak) { peak = mag[i]; best = i; } }
    const top = 6, bottom = height - 16;
    const Y = (v: number) => top + Math.min(1, -(20 * Math.log10(Math.max(v, 1e-9) / peak)) / 50) * (bottom - top);
    let d = `M0 ${bottom}`;
    for (let i = 1; i < bins; i++) d += `L${((i / (bins - 1)) * W).toFixed(1)} ${Y(mag[i]).toFixed(1)}`;
    const line = d.replace(`M0 ${bottom}L`, "M");
    const nyq = rate / 2;
    body = (
      <Svg width={W} height={height}>
        {[0, 100, 200, 300, 400].map((f) => {
          const x = (f / nyq) * W;
          return <React.Fragment key={f}>
            <Line x1={x} x2={x} y1={top} y2={bottom} stroke={t.grid} strokeWidth={1} />
            <SvgText x={Math.max(2, x)} y={height - 3} fill={t.muted} fontSize={10} textAnchor={f === 0 ? "start" : "middle"}>{f === 0 ? "0 Hz" : String(f)}</SvgText>
          </React.Fragment>;
        })}
        <Path d={d + `L${W} ${bottom}Z`} fill={color} fillOpacity={0.3} />
        <Path d={line} stroke={color} strokeWidth={1.2} fill="none" />
        <SvgText x={W - 8} y={14} fill={t.muted} fontSize={11} textAnchor="end">{`peak ${((best * rate) / FFT_N).toFixed(0)} Hz`}</SvgText>
      </Svg>
    );
  }
  return <View onLayout={onLayout} style={{ height, borderTopWidth: 1, borderTopColor: t.line }}>{body}</View>;
}

export function EffortMeter({ sensor, color }: { sensor: LiveSensor; color: string }) {
  const t = useTheme();
  useTick(120);
  const cal = sensor.cal, e = sensor.envNow;
  const pct = cal && e === e ? (e / cal.mvcRms) * 100 : null;
  const width = pct !== null ? Math.min(100, pct) : e === e ? Math.min(100, e / 5) : 0;
  const label = pct !== null ? `${pct.toFixed(0)}% MVC` : e === e ? `${e.toFixed(0)} µV` : "–";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingBottom: 12, paddingTop: 6 }}>
      <SvgLabel text="Effort" color={t.muted} />
      <View style={{ flex: 1, height: 10, borderRadius: 999, backgroundColor: t.panel2, overflow: "hidden" }}>
        <View style={{ width: `${width}%`, height: "100%", backgroundColor: color, borderRadius: 999 }} />
        {cal ? <View style={{ position: "absolute", top: 0, bottom: 0, width: 2, left: `${Math.min(100, (cal.threshold / cal.mvcRms) * 100)}%`, backgroundColor: t.ink, opacity: 0.5 }} /> : null}
      </View>
      <SvgLabel text={label} color={t.ink} bold width={78} />
    </View>
  );
}

function SvgLabel({ text, color, bold, width }: { text: string; color: string; bold?: boolean; width?: number }) {
  return <Text style={{ color, fontSize: 12.5, fontWeight: bold ? "600" : "400", width, textAlign: width ? "right" : "left", fontVariant: ["tabular-nums"] }}>{text}</Text>;
}

/** Tiny marker-aware overview plot for recorded data (precomputed columns). */
export function StaticPlot({ columns, overlay, height, color, ymin, ymax, markers, window, onPress, xLabels }: {
  columns: Columns; overlay?: Float32Array | null; height: number; color: string; ymin: number; ymax: number;
  markers?: { x: number; label: string }[]; window?: [number, number] | null; onPress?: (fraction: number) => void;
  xLabels?: { x: number; text: string }[];
}) {
  const t = useTheme();
  const [W, onLayout] = useWidth();
  let body: React.ReactNode = null;
  if (W > 0) {
    const top = 8, bottom = height - (xLabels ? 18 : 8), cols = columns.mins.length, xs = W / cols;
    const Y = (v: number) => bottom - ((Math.max(ymin, Math.min(ymax, v)) - ymin) / (ymax - ymin || 1)) * (bottom - top);
    body = (
      <Svg width={W} height={height}>
        {window ? <Rect x={window[0] * W} y={top} width={Math.max(2, (window[1] - window[0]) * W)} height={bottom - top} fill={t.accent} fillOpacity={0.12} /> : null}
        {ymin < 0 && ymax > 0 ? <Line x1={0} x2={W} y1={Y(0)} y2={Y(0)} stroke={t.grid} /> : null}
        <Path d={columnsPath(columns, Y, xs)} stroke={color} strokeWidth={1.2} fill="none" strokeOpacity={overlay ? 0.75 : 1} />
        {overlay ? <Path d={envelopePath(overlay, Y, 1, xs)} stroke={t.ink} strokeWidth={1.5} fill="none" /> : null}
        {overlay && ymin < 0 ? <Path d={envelopePath(overlay, Y, -1, xs)} stroke={t.ink} strokeWidth={1.5} fill="none" /> : null}
        {markers?.map((m, i) => (
          <React.Fragment key={i}>
            <Line x1={m.x * W} x2={m.x * W} y1={top} y2={bottom} stroke={t.warn} strokeWidth={1.2} />
            <SvgText x={m.x * W + 3} y={top + 10} fill={t.warn} fontSize={10}>{m.label}</SvgText>
          </React.Fragment>
        ))}
        {xLabels?.map((l, i) => (
          <SvgText key={i} x={l.x * W} y={height - 4} fill={t.muted} fontSize={10} textAnchor={l.x < 0.05 ? "start" : l.x > 0.95 ? "end" : "middle"}>{l.text}</SvgText>
        ))}
        <SvgText x={8} y={18} fill={t.muted} fontSize={11}>{uvLabel(ymax)}</SvgText>
      </Svg>
    );
  }
  return (
    <View
      onLayout={onLayout}
      style={{ height }}
      onStartShouldSetResponder={() => !!onPress}
      onResponderRelease={(e) => onPress && W && onPress(Math.max(0, Math.min(1, e.nativeEvent.locationX / W)))}
    >
      {body}
    </View>
  );
}
