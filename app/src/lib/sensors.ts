/**
 * Live sensor state for the UI. Packets arrive from the native module (which also writes
 * them to disk while recording); this store keeps ring buffers for plotting, stats, and
 * calibration capture. Nothing here is needed for a recording to be complete.
 */
import { useSyncExternalStore } from "react";
import { PermissionsAndroid, Platform } from "react-native";
import Native, { type SensorState } from "../../modules/myoblue-native";
import { Chain } from "../core/dsp";
import { DemoSensor } from "../core/demo";
import { base64ToBytes, bytesToBase64, parsePacket, PER_PACKET, seqGap, SENSOR_NAME_RE, shortName } from "../core/protocol";
import type { Calibration } from "../core/calibration";
import { getSettings, updateSettings } from "./settings";

export const RING = 10240;

export type LiveState = SensorState | "demo";

export class LiveSensor {
  readonly short: string;
  state: LiveState = "connecting";
  battery: number | null = null;
  packets = 0;
  lost = 0;
  lastSeq = -1;
  lastPacketAt = 0;
  rate = 0;
  private rateCount = 0;
  private rateT = 0;
  raw = new Float32Array(RING).fill(NaN);
  filt = new Float32Array(RING).fill(NaN);
  env = new Float32Array(RING).fill(NaN);
  w = 0;
  envNow = NaN;
  chain: Chain;
  /** calibration capture sink (envelope samples) */
  capture: number[] | null = null;
  /** peak-hold y range, reset by tapping the plot */
  hold: { key: string; ymin: number; ymax: number } | null = null;
  demo: DemoSensor | null = null;

  constructor(readonly id: string, public name: string, readonly source: "ble" | "demo") {
    this.short = shortName(name);
    this.chain = this.makeChain();
  }

  get cal(): Calibration | null {
    return getSettings().calibrations[this.name] ?? null;
  }

  get lossPct(): number {
    return this.packets ? (100 * this.lost) / (this.lost + this.packets) : 0;
  }

  makeChain() {
    const s = getSettings();
    const c = new Chain({ band: s.band, notch: s.notch }, this.rate > 500 ? this.rate : 975);
    c.reset();
    return c;
  }

  private push(r: number, f: number, e: number) {
    this.raw[this.w] = r; this.filt[this.w] = f; this.env[this.w] = e;
    this.w = (this.w + 1) % RING;
    if (e === e) this.envNow = e;
  }

  onPacket(bytes: Uint8Array, t: number) {
    const p = parsePacket(bytes);
    if (!p) return;
    this.battery = p.battery;
    if (this.lastSeq >= 0) {
      const gap = seqGap(this.lastSeq, p.seq);
      if (gap > 0 && gap < 5000) {
        this.lost += gap;
        for (let i = 0; i < Math.min(gap * PER_PACKET, RING); i++) this.push(NaN, NaN, NaN);
        this.chain.reset();
      }
    }
    this.lastSeq = p.seq;
    this.packets++;
    this.lastPacketAt = t;
    // sample rate over ~2 s windows (packets arrive in bursts)
    this.rateCount++;
    if (!this.rateT) this.rateT = t;
    else if (t - this.rateT >= 2000) {
      this.rate = (this.rateCount * PER_PACKET * 1000) / (t - this.rateT);
      this.rateCount = 0;
      this.rateT = t;
    }
    if (p.empty) {
      for (let i = 0; i < PER_PACKET; i++) this.push(NaN, NaN, NaN);
      this.chain.reset();
      return;
    }
    for (let i = 0; i < PER_PACKET; i++) {
      this.chain.step(p.uv[i]);
      this.push(p.uv[i], this.chain.filtered, this.chain.envelope);
      if (this.capture && this.chain.envelope === this.chain.envelope) this.capture.push(this.chain.envelope);
    }
  }
}

/* ---------------- store ---------------- */

const sensors = new Map<string, LiveSensor>();
let snapshot: LiveSensor[] = [];
const listeners = new Set<() => void>();
function changed() {
  snapshot = [...sensors.values()].sort((a, b) => a.short.localeCompare(b.short));
  listeners.forEach((l) => l());
}
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };

export function useSensors(): LiveSensor[] {
  return useSyncExternalStore(subscribe, () => snapshot);
}
export const getSensors = () => snapshot;
export const getSensor = (id: string) => sensors.get(id);

/* discovered devices while scanning */
export interface Found { id: string; name: string; rssi: number; seenAt: number }
let found: Found[] = [];
const foundListeners = new Set<() => void>();
export function useFound(): Found[] {
  return useSyncExternalStore((cb) => { foundListeners.add(cb); return () => { foundListeners.delete(cb); }; }, () => found);
}

export const nativeAvailable = !!Native;

/* ---------------- native events ---------------- */

let wired = false;
export function initSensors() {
  if (wired) return;
  wired = true;
  if (!Native) return;
  Native.addListener("onPacket", (e) => {
    let s = sensors.get(e.id);
    if (!s) return;
    s.onPacket(base64ToBytes(e.data), e.t);
    if (s.state !== "live" && s.state !== "demo") { s.state = s.source === "demo" ? "demo" : "live"; changed(); }
  });
  Native.addListener("onSensorState", (e) => {
    const s = sensors.get(e.id);
    if (!s || s.source === "demo") return;
    s.state = e.state;
    changed();
  });
  Native.addListener("onDevice", (e) => {
    const now = Date.now();
    const i = found.findIndex((f) => f.id === e.id);
    const item = { id: e.id, name: e.name, rssi: e.rssi, seenAt: now };
    found = i >= 0 ? found.map((f, j) => (j === i ? item : f)) : [...found, item].sort((a, b) => a.name.localeCompare(b.name));
    foundListeners.forEach((l) => l());
  });
  // sensors the native side already holds (e.g. after a JS reload while recording)
  for (const n of Native.sensors()) {
    if (!sensors.has(n.id)) {
      const s = new LiveSensor(n.id, n.name, "ble");
      s.state = n.state;
      sensors.set(n.id, s);
    }
  }
  // reconnect sensors used before
  for (const k of getSettings().knownSensors) if (!sensors.has(k.id)) connectSensor(k.id, k.name, false);
  changed();
}

export async function ensurePermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const P = PermissionsAndroid.PERMISSIONS;
  const wanted = Platform.Version >= 31
    ? [P.BLUETOOTH_SCAN, P.BLUETOOTH_CONNECT, ...(Platform.Version >= 33 ? [P.POST_NOTIFICATIONS] : [])]
    : [P.ACCESS_FINE_LOCATION];
  const res = await PermissionsAndroid.requestMultiple(wanted.filter(Boolean) as any);
  // notifications are optional (recording still works); Bluetooth ones are required
  return wanted.filter((p) => p !== P.POST_NOTIFICATIONS).every((p) => res[p] === PermissionsAndroid.RESULTS.GRANTED);
}

export function startScan(): boolean {
  found = found.filter((f) => Date.now() - f.seenAt < 15000);
  foundListeners.forEach((l) => l());
  return Native?.startScan() ?? false;
}
export function stopScan() { Native?.stopScan(); }

export function connectSensor(id: string, name: string, remember = true) {
  if (!Native || !SENSOR_NAME_RE.test(name)) return;
  let s = sensors.get(id);
  if (!s) { s = new LiveSensor(id, name, "ble"); sensors.set(id, s); }
  s.state = "connecting";
  Native.connect(id, name);
  if (remember) {
    const known = getSettings().knownSensors.filter((k) => k.id !== id);
    updateSettings({ knownSensors: [...known, { id, name }] });
  }
  changed();
}

export function removeSensor(id: string) {
  const s = sensors.get(id);
  if (!s) return;
  if (s.source === "demo") stopDemo(s);
  else Native?.disconnect(id);
  sensors.delete(id);
  updateSettings({ knownSensors: getSettings().knownSensors.filter((k) => k.id !== id) });
  changed();
}

export function rebuildFilters() {
  for (const s of sensors.values()) { s.chain = s.makeChain(); s.hold = null; }
}

export function resetHolds() {
  for (const s of sensors.values()) s.hold = null;
}

/* ---------------- demo sensors ---------------- */

const demoTimers = new Map<string, ReturnType<typeof setInterval>>();

export function addDemoSensor() {
  const n = [...sensors.values()].filter((s) => s.source === "demo").length + 1;
  const id = `demo-${n}-${Date.now()}`;
  const name = `${n}_MYOblue_demo`;
  const s = new LiveSensor(id, name, "demo");
  s.state = "demo";
  s.demo = new DemoSensor(n);
  sensors.set(id, s);
  changed();
  const started = Date.now();
  let sent = 0;
  // emit by elapsed time so timer jitter doesn't change the rate
  demoTimers.set(id, setInterval(() => {
    const due = Math.floor((Date.now() - started) / DemoSensor.INTERVAL);
    for (let k = 0; sent < due && k < 50; k++, sent++) {
      const pkt = s.demo!.next();
      if (Math.random() < 0.003) continue; // an occasional lost packet
      if (Native) Native.injectPacket(id, name, bytesToBase64(pkt)); // recorded natively, echoed back as onPacket
      else s.onPacket(pkt, Date.now());
    }
  }, 60));
}

function stopDemo(s: LiveSensor) {
  const t = demoTimers.get(s.id);
  if (t) clearInterval(t);
  demoTimers.delete(s.id);
}

export function setDemoHint(hint: "rest" | "mvc" | null) {
  for (const s of sensors.values()) if (s.demo) s.demo.hint = hint;
}
