import { useSyncExternalStore } from "react";
import { File, Paths } from "expo-file-system";
import type { BandId } from "../core/dsp";
import type { Calibration } from "../core/calibration";

export type ViewMode = "filtered" | "raw" | "envelope";
export type YScale = "auto" | "hold" | "mvc" | "100" | "250" | "500" | "1000" | "2500";

export interface Settings {
  viewMode: ViewMode;
  band: BandId;
  notch: 0 | 50 | 60;
  win: 2 | 5 | 10;
  scale: YScale;
  overlay: boolean;
  spectrum: boolean;
  markerLabels: string;
  /** sensors to reconnect automatically when the app starts */
  knownSensors: { id: string; name: string }[];
  /** keyed by sensor name (stable across phones) */
  calibrations: Record<string, Calibration>;
}

const DEFAULTS: Settings = {
  viewMode: "filtered",
  band: "emg",
  notch: 50,
  win: 5,
  scale: "auto",
  overlay: true,
  spectrum: false,
  markerLabels: "rest, contract, trial",
  knownSensors: [],
  calibrations: {},
};

const file = () => new File(Paths.document, "settings.json");

function load(): Settings {
  try {
    const f = file();
    if (f.exists) return { ...DEFAULTS, ...JSON.parse(f.textSync()) };
  } catch {}
  return { ...DEFAULTS };
}

let current: Settings = load();
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try {
    const f = file();
    if (!f.exists) f.create();
    f.write(JSON.stringify(current, null, 2));
  } catch {}
  listeners.forEach((l) => l());
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => current,
  );
}

export function markerLabels(s: Settings): string[] {
  return s.markerLabels.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 8);
}
