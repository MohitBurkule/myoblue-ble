import type { FilterSettings } from "./dsp";

export interface Calibration {
  /** mean envelope while relaxed (µV RMS) */
  restRms: number;
  restSd: number;
  /** 95th percentile of the envelope during maximum voluntary contraction (µV RMS) */
  mvcRms: number;
  /** envelope above this counts as "active" */
  threshold: number;
  snrDb: number;
  date: string;
  filters: FilterSettings;
}

export type Verdict = "good" | "ok" | "poor";

export function percentile(values: ArrayLike<number>, p: number): number {
  if (!values.length) return NaN;
  const a = Float64Array.from(values).sort();
  return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
}

/** Envelope samples from the rest and MVC phases -> calibration, or null if too little data. */
export function summarize(rest: number[], mvc: number[], filters: FilterSettings): Calibration | null {
  if (rest.length < 500 || mvc.length < 500) return null;
  const r = rest.slice(500); // drop the first ~0.5 s
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / r.length);
  const mvcRms = percentile(mvc, 0.95);
  return {
    restRms: mean,
    restSd: sd,
    mvcRms,
    threshold: Math.max(mean + 3 * sd, mean * 1.5),
    snrDb: 20 * Math.log10(Math.max(mvcRms, 1e-6) / Math.max(mean, 1e-6)),
    date: new Date().toISOString(),
    filters,
  };
}

export function verdict(cal: Calibration): Verdict {
  return cal.snrDb >= 20 ? "good" : cal.snrDb >= 10 ? "ok" : "poor";
}

export const VERDICT_LABEL: Record<Verdict, string> = { good: "Good", ok: "Usable", poor: "Check contact" };
