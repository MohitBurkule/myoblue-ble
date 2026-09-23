/**
 * Recording control. The native side does the real work (foreground service, one
 * append-only .bin per sensor, markers.jsonl, status.json); this writes session.json
 * with the human-facing metadata and mirrors the state for the UI.
 */
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import Native from "../../modules/myoblue-native";
import type { SessionMeta } from "../core/session";
import { getSensors } from "./sensors";
import { getSettings } from "./settings";

export const APP_VERSION = "1.0.0";

export interface RecState {
  active: boolean;
  id: string | null;
  name: string;
  startedAt: number; // Date.now() at start
  markers: { t: number; label: string }[];
}

let state: RecState = { active: false, id: null, name: "", startedAt: 0, markers: [] };
const listeners = new Set<() => void>();
const set = (patch: Partial<RecState>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };

export function useRecording(): RecState {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => state);
}
export const getRecording = () => state;

export function recordingsDir(): Directory {
  const d = new Directory(Paths.document, "recordings");
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

let wired = false;
export function initRecorder() {
  if (wired || !Native) return;
  wired = true;
  Native.addListener("onMarker", (e) => set({ markers: [...state.markers, e] }));
  Native.addListener("onRecording", (e) => {
    if (!e.active) set({ active: false });
  });
  // the app may have been restarted while the service kept recording
  const st = Native.recordingStatus();
  if (st) {
    const id = st.path.split("/").filter(Boolean).pop() ?? null;
    let name = "Recording";
    try { name = JSON.parse(new File(recordingsDir(), id!, "session.json").textSync()).name; } catch {}
    set({ active: true, id, name, startedAt: st.startedAt, markers: [] });
  }
}

export function startRecording(name: string, notes: string): boolean {
  if (!Native || state.active) return false;
  const now = new Date();
  const id = now.toISOString().replace(/[:.]/g, "-");
  const dir = new Directory(recordingsDir(), id);
  dir.create({ intermediates: true, idempotent: true });
  const s = getSettings();
  const meta: SessionMeta = {
    id, name, notes, createdAt: now.toISOString(),
    filters: { band: s.band, notch: s.notch },
    sensors: getSensors().map((x) => ({ id: x.id, name: x.name, short: x.short, calibration: x.cal })),
    app: { version: APP_VERSION, platform: `${Platform.OS} ${Platform.Version}` },
  };
  const f = new File(dir, "session.json");
  f.create();
  f.write(JSON.stringify(meta, null, 2));
  if (!Native.startRecording(dir.uri, name)) return false;
  set({ active: true, id, name, startedAt: Date.now(), markers: [] });
  return true;
}

export function addMarker(label: string) {
  Native?.addMarker(label);
}

export function stopRecording(): string | null {
  if (!Native) return null;
  Native.stopRecording();
  const id = state.id;
  set({ active: false });
  // sensors that joined mid-recording get their metadata now (calibration may have been done since)
  if (id) {
    try {
      const f = new File(recordingsDir(), id, "session.json");
      const meta: SessionMeta = JSON.parse(f.textSync());
      for (const s of getSensors()) {
        if (!meta.sensors.some((m) => m.id === s.id)) meta.sensors.push({ id: s.id, name: s.name, short: s.short, calibration: s.cal });
      }
      f.write(JSON.stringify(meta, null, 2));
    } catch {}
  }
  return id;
}
