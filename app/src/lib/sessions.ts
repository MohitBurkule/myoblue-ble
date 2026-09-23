/** Recorded sessions on disk: list, load + analyse, export, delete. */
import { Directory, File } from "expo-file-system";
import * as Sharing from "expo-sharing";
import type { FilterSettings } from "../core/dsp";
import { ROW_BYTES, shortName } from "../core/protocol";
import {
  alignGrid, buildSeries, fileBase, metaJson, sessionDurationMs, writeCsv,
  type Marker, type SensorMeta, type Series, type SessionMeta, type SessionStatus,
} from "../core/session";
import { recordingsDir } from "./recorder";

export interface SessionSummary {
  id: string;
  meta: SessionMeta;
  status: SessionStatus;
  complete: boolean;
  bytes: number;
  sensorCount: number;
  markerCount: number;
  durationMs: number;
}

export interface LoadedSession extends SessionSummary {
  markers: Marker[];
  series: Series[];
  filters: FilterSettings;
}

function readJson<T>(f: File, fallback: T): T {
  try { return f.exists ? JSON.parse(f.textSync()) : fallback; } catch { return fallback; }
}

function readMarkers(dir: Directory): Marker[] {
  const f = new File(dir, "markers.jsonl");
  if (!f.exists) return [];
  return f.textSync().split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

/** Sensors in a session: native sensors.json (every sensor that sent data) + metadata from session.json. */
function sensorFiles(dir: Directory, meta: SessionMeta): { meta: SensorMeta; file: File }[] {
  const native: { id: string; name: string; file: string }[] = readJson(new File(dir, "sensors.json"), []);
  return native.map((n, i) => {
    const m = meta.sensors.find((s) => s.id === n.id);
    return { meta: m ?? { id: n.id, name: n.name, short: shortName(n.name, i + 1), calibration: null }, file: new File(dir, n.file) };
  });
}

function summarize(dir: Directory): SessionSummary | null {
  const meta: SessionMeta | null = readJson(new File(dir, "session.json"), null);
  if (!meta) return null;
  const status: SessionStatus = readJson(new File(dir, "status.json"), {});
  const files = sensorFiles(dir, meta);
  const bytes = files.reduce((n, f) => n + (f.file.exists ? f.file.size : 0), 0);
  // without status.json (app killed mid-recording) estimate duration from the data size
  const maxPackets = Math.max(0, ...files.map((f) => (f.file.exists ? f.file.size / ROW_BYTES : 0)));
  return {
    id: dir.name,
    meta,
    status,
    complete: !!status.endedAt,
    bytes,
    sensorCount: files.length,
    markerCount: readMarkers(dir).length,
    durationMs: status.durationMs ?? maxPackets * 122,
  };
}

export function listSessions(): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (const item of recordingsDir().list()) {
    if (!(item instanceof Directory)) continue;
    const s = summarize(item);
    if (s) out.push(s);
  }
  return out.sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt));
}

export async function loadSession(id: string, filters?: FilterSettings): Promise<LoadedSession | null> {
  const dir = new Directory(recordingsDir(), id);
  const summary = summarize(dir);
  if (!summary) return null;
  const f = filters ?? summary.meta.filters;
  const series: Series[] = [];
  for (const sf of sensorFiles(dir, summary.meta)) {
    if (!sf.file.exists) continue;
    const s = buildSeries(sf.meta, await sf.file.bytes(), f);
    if (s) series.push(s);
  }
  return { ...summary, markers: readMarkers(dir), series, filters: f, durationMs: sessionDurationMs(summary.status, series) };
}

/** Write <base>.csv and <base>.json into the session folder; returns both files. */
export function exportSession(s: LoadedSession): { csv: File; json: File } {
  const dir = new Directory(recordingsDir(), s.id);
  const base = fileBase(s.meta);
  const csv = new File(dir, base + ".csv");
  if (csv.exists) csv.delete();
  csv.create();
  writeCsv(s.series, alignGrid(s.series), s.markers, (chunk) => csv.write(chunk, { append: true }));
  const json = new File(dir, base + ".json");
  if (json.exists) json.delete();
  json.create();
  json.write(JSON.stringify(metaJson(s.meta, s.status, s.markers, s.series, s.filters), null, 2));
  return { csv, json };
}

export async function share(file: File, mimeType: string) {
  if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing isn't available on this device");
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: file.name });
}

export function updateSessionMeta(id: string, patch: Partial<Pick<SessionMeta, "name" | "notes">>) {
  const f = new File(recordingsDir(), id, "session.json");
  const meta: SessionMeta = JSON.parse(f.textSync());
  f.write(JSON.stringify({ ...meta, ...patch }, null, 2));
}

export function deleteSession(id: string) {
  const d = new Directory(recordingsDir(), id);
  if (d.exists) d.delete();
}
