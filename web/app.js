"use strict";
/* MYOblue Recorder: Web Bluetooth client for ELEMYO MYOblue EMG sensors.
 *
 * Sensor protocol (MYOblue v1.2 datasheet): Nordic UART Service, notifications on TX.
 * Each notification is 244 bytes: module (u8), sequence (u24 LE), battery (u16 LE),
 * then 119 samples (u16 LE, 14-bit, 8192 = 0). 1000 samples/s.
 * Once a minute the sensor measures its battery instead of EMG and sends a packet
 * whose samples are all 8192; those are treated as missing data.
 */

const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
const FS = 1000;
const PER_PACKET = 119;
const PACKET_BYTES = 6 + PER_PACKET * 2;
const UV_PER_LSB = 2.5 / 16384 * 2000;          // same scale as MYOblue_GUI
const BATTERY_V_PER_LSB = 0.6 * 6 * 2 / 16384;  // same as MYOblue_GUI
const RING = FS * 10;
const ENV_WINDOW = 100;                          // ms, moving RMS for envelope
const REC_ROW_BYTES = 8 + PACKET_BYTES;          // float64 host time + raw packet
const DEMO_RATE = 976;                           // real sensors run ~2-3% below 1 kHz

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};

/* ---------------- settings ---------------- */

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem("myoblue." + key); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem("myoblue." + key, JSON.stringify(value)); } catch {} },
  del(key) { try { localStorage.removeItem("myoblue." + key); } catch {} },
};

const settings = Object.assign(
  { viewMode: "filtered", band: "emg", notch: 50, win: 5, scale: "auto", overlay: true, spectrum: false,
    markerLabels: "rest, contract, trial" },
  store.get("settings", {}),
);
if (typeof settings.scale === "number") settings.scale = settings.scale ? String(settings.scale) : "auto"; // v1.0
if ("hp" in settings) { if (!store.get("settings", {}).band) settings.band = settings.hp === 0 ? "wide" : "emg"; delete settings.hp; }
function saveSettings() { store.set("settings", settings); }

/* ---------------- DSP ---------------- */

function biquad(type, f0, q) {
  const w = 2 * Math.PI * f0 / FS, c = Math.cos(w), alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  let b0, b1, b2;
  if (type === "hp") { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
  else if (type === "lp") { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
  else { b0 = 1; b1 = -2 * c; b2 = 1; }  // notch
  const k = [b0 / a0, b1 / a0, b2 / a0, (-2 * c) / a0, (1 - alpha) / a0];
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const f = (x) => {
    const y = k[0] * x + k[1] * x1 + k[2] * x2 - k[3] * y1 - k[4] * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
  f.reset = () => { x1 = x2 = y1 = y2 = 0; };
  return f;
}

/** Signal presets. "wide" matches MYOblue_GUI's default band-pass (2-480 Hz). */
const BANDS = {
  emg: { label: "EMG (20 Hz high-pass)", hp: 20, order: 4 },
  wide: { label: "Wide 2-480 Hz (like MYOblue GUI; shows ECG)", hp: 2, order: 2, lp: 480 },
  ecg: { label: "ECG / heart (0.5-40 Hz)", hp: 0.5, order: 2, lp: 40 },
};
const BUTTERWORTH_Q = { 2: [0.7071], 4: [0.5412, 1.3066] };

/** Band filter + notch + moving-RMS envelope, one sample at a time. */
class Chain {
  constructor({ band, notch }) {
    const b = BANDS[band] || BANDS.emg;
    this.stages = [];
    for (const q of BUTTERWORTH_Q[b.order]) this.stages.push(biquad("hp", b.hp, q));
    if (b.lp) for (const q of BUTTERWORTH_Q[4]) this.stages.push(biquad("lp", b.lp, q));
    if (notch) for (const h of [1, 2, 3]) if (!b.lp || notch * h < b.lp) this.stages.push(biquad("notch", notch * h, 8));
    this.win = new Float64Array(ENV_WINDOW);
    this.wi = 0; this.acc = 0;
    this.settle = 0;
  }
  reset() {
    for (const s of this.stages) s.reset();
    this.win.fill(0); this.acc = 0; this.wi = 0;
    this.settle = 300; // samples to ignore after a gap while filters settle
  }
  /** returns [filtered, envelope] */
  step(x) {
    let y = x;
    for (const s of this.stages) y = s(y);
    const sq = y * y;
    this.acc += sq - this.win[this.wi];
    this.win[this.wi] = sq;
    this.wi = (this.wi + 1) % ENV_WINDOW;
    if (this.settle > 0) { this.settle--; return [NaN, NaN]; }
    return [y, Math.sqrt(Math.max(this.acc, 0) / ENV_WINDOW)];
  }
}

/* ---------------- calibration ---------------- */

const calibration = {
  get(name) { return store.get("cal." + name, null); },
  set(name, cal) { store.set("cal." + name, cal); },
  clear(name) { store.del("cal." + name); },
};

/* ---------------- sensors ---------------- */

const sensors = new Map(); // key -> Sensor
let colorCursor = 0;

class Sensor {
  constructor({ key, name, source, device = null }) {
    this.key = key;
    this.name = name;
    this.source = source; // "ble" | "demo"
    this.device = device;
    const n = parseInt(name, 10);
    this.index = Number.isFinite(n) && n > 0 ? n : ++colorCursor;
    this.short = "S" + this.index;
    this.color = `var(--s${((this.index - 1) % 8) + 1})`;
    this.module = null;
    this.battery = null;
    this.state = "connecting";
    this.closed = false;
    this.lastSeq = null;
    this.packets = 0;
    this.lost = 0;
    this.lastPacketAt = 0;
    this.rateCount = 0;
    this.rate = 0;
    this.raw = new Float32Array(RING).fill(NaN);
    this.filt = new Float32Array(RING).fill(NaN);
    this.env = new Float32Array(RING).fill(NaN);
    this.w = 0;
    this.envNow = NaN;
    this.cal = calibration.get(name);
    this.capture = null; // calibration capture sink
    this.rebuildChain();
    this.ui = buildCard(this);
  }
  rebuildChain() { this.chain = new Chain(settings); this.chain.reset(); }

  onPacket(dv, hostTime) {
    if (dv.byteLength < PACKET_BYTES) return;
    const module = dv.getUint8(0);
    const seq = dv.getUint8(1) | (dv.getUint8(2) << 8) | (dv.getUint8(3) << 16);
    this.module = module;
    this.battery = dv.getUint16(4, true) * BATTERY_V_PER_LSB;
    if (this.lastSeq !== null) {
      const gap = (seq - this.lastSeq - 1) & 0xffffff;
      if (gap > 0 && gap < 5000) {
        this.lost += gap;
        for (let i = 0; i < Math.min(gap * PER_PACKET, RING); i++) this.push(NaN, NaN, NaN);
        this.chain.reset();
      }
    }
    this.lastSeq = seq;
    this.packets++;
    this.rateCount++;
    this.lastPacketAt = hostTime;

    let empty = true;
    for (let i = 0; i < PER_PACKET; i++) if (dv.getUint16(6 + i * 2, true) !== 8192) { empty = false; break; }
    if (empty) { // battery-measurement packet: no EMG in it
      for (let i = 0; i < PER_PACKET; i++) this.push(NaN, NaN, NaN);
      this.chain.reset();
    } else {
      for (let i = 0; i < PER_PACKET; i++) {
        const uv = (dv.getUint16(6 + i * 2, true) - 8192) * UV_PER_LSB;
        const [f, e] = this.chain.step(uv);
        this.push(uv, f, e);
        if (this.capture && e === e) this.capture.push(e);
      }
    }
    recorder.addPacket(this, hostTime, dv);
    if (this.state !== "live") setState(this, "live");
  }
  push(r, f, e) {
    this.raw[this.w] = r; this.filt[this.w] = f; this.env[this.w] = e;
    this.w = (this.w + 1) % RING;
    if (e === e) this.envNow = e;
  }
  get lossPct() { return this.packets ? 100 * this.lost / (this.lost + this.packets) : 0; }
}

function setState(s, state, detail = "") {
  s.state = state;
  const labels = { connecting: "Connecting…", live: "Live", reconnecting: "Reconnecting…", stalled: "No data", failed: "Disconnected",
    demo: "Demo", searching: "Waiting for sensor — switch it on" };
  const cls = { live: "live", demo: "live", connecting: "warn", reconnecting: "warn", stalled: "warn", failed: "bad", searching: "warn" };
  s.ui.state.textContent = (s.source === "demo" && state === "live") ? "Demo" : (labels[state] || state);
  s.ui.state.className = "pill " + (cls[state] || "");
  s.ui.state.title = detail;
  s.ui.reconnect.hidden = !(state === "failed" || state === "searching") || s.source !== "ble";
  updateActions();
}

/* ---------------- Web Bluetooth ---------------- */

async function addBleSensor() {
  if (!navigator.bluetooth) return;
  let device;
  try {
    const filters = [];
    for (let i = 1; i <= 8; i++) filters.push({ namePrefix: `${i}_MYOblue` });
    filters.push({ services: [NUS_SERVICE] });
    device = await navigator.bluetooth.requestDevice({ filters, optionalServices: [NUS_SERVICE] });
  } catch (e) {
    if (e.name !== "NotFoundError") showBanner(`Couldn't open the Bluetooth picker: ${e.message}`, true);
    return;
  }
  const existing = sensors.get(device.id);
  if (existing) { if (existing.state === "failed" || existing.state === "searching") connectBle(existing); return; }
  attachBleDevice(device).then(connectBle);
}

async function attachBleDevice(device) {
  const s = new Sensor({ key: device.id, name: device.name || "MYOblue", source: "ble", device });
  sensors.set(s.key, s);
  device.addEventListener("gattserverdisconnected", () => {
    if (s.closed) return;
    setState(s, "reconnecting");
    connectBle(s);
  });
  recorder.sensorJoined(s);
  updateLayout();
  return s;
}

/**
 * Reconnect sensors this site was allowed to use before a reload.
 * Needs navigator.bluetooth.getDevices() (Chrome's persistent Bluetooth permissions).
 */
async function restoreBleSensors() {
  if (!navigator.bluetooth) return;
  if (!navigator.bluetooth.getDevices) {
    if (store.get("usedBle", false)) showBanner("This browser doesn't let web pages remember Bluetooth devices, so tap Add sensor again after a reload. "
      + "In Chrome you can turn it on at chrome://flags/#enable-web-bluetooth-new-permissions-backend (copy it into the address bar).");
    return;
  }
  let devices = [];
  try { devices = await navigator.bluetooth.getDevices(); } catch { return; }
  for (const device of devices) {
    if (!/MYOblue/i.test(device.name || "") || sensors.has(device.id)) continue;
    const s = await attachBleDevice(device);
    if (device.watchAdvertisements) {
      // connect as soon as the sensor is heard, so a sensor switched on later still connects
      setState(s, "searching");
      s.watch = new AbortController();
      device.addEventListener("advertisementreceived", () => {
        if (s.state !== "searching") return;
        s.watch.abort();
        connectBle(s);
      });
      device.watchAdvertisements({ signal: s.watch.signal }).catch(() => connectBle(s));
    } else {
      connectBle(s);
    }
  }
}

async function connectBle(s) {
  if (s.connecting) return;
  s.connecting = true;
  setState(s, s.packets ? "reconnecting" : "connecting");
  let lastErr;
  for (let attempt = 1; attempt <= 6 && !s.closed; attempt++) {
    try {
      const server = await s.device.gatt.connect();
      const service = await server.getPrimaryService(NUS_SERVICE);
      const tx = await service.getCharacteristic(NUS_TX);
      if (!s.listening) {
        tx.addEventListener("characteristicvaluechanged", (ev) => s.onPacket(ev.target.value, performance.now()));
        s.listening = true;
      }
      await tx.startNotifications();
      s.connecting = false;
      s.lastPacketAt = performance.now();
      store.set("usedBle", true);
      keepAwake();
      return;
    } catch (e) {
      lastErr = e;
      await sleep(Math.min(500 * attempt, 2500));
    }
  }
  s.connecting = false;
  if (!s.closed) setState(s, "failed", lastErr ? lastErr.message : "");
}

function removeSensor(s) {
  s.closed = true;
  s.watch?.abort();
  if (s.source === "ble" && s.device?.gatt.connected) s.device.gatt.disconnect();
  if (s.source === "ble") s.device?.forget?.().catch(() => {});  // don't auto-reconnect after reload
  if (s.demoTimer) clearInterval(s.demoTimer);
  s.ui.card.remove();
  sensors.delete(s.key);
  updateLayout();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- demo sensor ---------------- */

function addDemoSensor() {
  const n = [...sensors.values()].filter((s) => s.source === "demo").length + 1;
  const name = `${n}_MYOblue_demo`;
  const s = new Sensor({ key: "demo-" + n + "-" + Date.now(), name, source: "demo" });
  sensors.set(s.key, s);
  recorder.sensorJoined(s);
  updateLayout();
  let seq = 0, t = 0, burstAmp = 0, burstUntil = 0, nextBurst = 1500 + Math.random() * 1500, lp = 0;
  const buf = new ArrayBuffer(PACKET_BYTES), dv = new DataView(buf);
  const phase = Math.random() * 6;
  const started = performance.now();
  const emit = () => {
    dv.setUint8(0, n);
    dv.setUint8(1, seq & 255); dv.setUint8(2, (seq >> 8) & 255); dv.setUint8(3, (seq >> 16) & 255);
    dv.setUint16(4, Math.round((3.0 - seq * 1e-6) / BATTERY_V_PER_LSB), true);
    const batteryPacket = seq > 0 && seq % 492 === 0; // ~once a minute, like the real sensor
    for (let i = 0; i < PER_PACKET; i++, t++) {
      if (cal.hint === "rest") { burstUntil = 0; nextBurst = t + 800; }
      else if (cal.hint === "mvc") { burstAmp = 300; burstUntil = t + 200; nextBurst = t + 1e9; }
      else if (nextBurst > t + 1e8) nextBurst = t + 1000;
      if (t >= nextBurst) { burstAmp = 60 + Math.random() * 260; burstUntil = t + 600 + Math.random() * 900; nextBurst = burstUntil + 1200 + Math.random() * 2500; }
      const ramp = t < burstUntil ? Math.min(1, (burstUntil - t) / 150, 1) : 0;
      const g = (Math.random() + Math.random() + Math.random() - 1.5) * 1.6;
      lp = 0.55 * lp + 0.45 * g;                                // band-limit the burst noise
      const emg = (g - lp) * burstAmp * ramp;
      const beat = (t % 850) - 60;                                   // ~70 bpm ECG pickup
      const ecg = 110 * Math.exp(-(beat * beat) / 60) - 25 * Math.exp(-((beat - 12) ** 2) / 40) + 22 * Math.exp(-((beat - 260) ** 2) / 2500);
      const uv = emg + ecg + g * 4 + 18 * Math.sin(2 * Math.PI * 50 * t / DEMO_RATE + phase) + 40 * Math.sin(2 * Math.PI * 0.3 * t / DEMO_RATE);
      const raw = batteryPacket ? 8192 : Math.max(0, Math.min(16383, Math.round(8192 + uv / UV_PER_LSB)));
      dv.setUint16(6 + i * 2, raw, true);
    }
    if (Math.random() > 0.004) s.onPacket(dv, performance.now()); // occasional dropped packet
    seq = (seq + 1) & 0xffffff;
  };
  // emit by elapsed time so throttled timers (background tabs) still give 1 kHz
  s.demoTimer = setInterval(() => {
    const due = Math.floor((performance.now() - started) / (PER_PACKET * 1000 / DEMO_RATE));
    for (let k = 0; seq < due && k < 100; k++) emit();
  }, PER_PACKET);
}

/* ---------------- IndexedDB ---------------- */

const db = {
  handle: null,
  open() {
    if (this.handle) return this.handle;
    this.handle = new Promise((resolve, reject) => {
      const req = indexedDB.open("myoblue", 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore("recordings", { keyPath: "id" });
        const chunks = d.createObjectStore("chunks", { autoIncrement: true });
        chunks.createIndex("recId", "recId");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.handle;
  },
  async tx(stores, mode, fn) {
    const d = await this.open();
    return new Promise((resolve, reject) => {
      const t = d.transaction(stores, mode);
      let out;
      Promise.resolve(fn(t)).then((v) => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  },
  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  putRecording(rec) { return this.tx(["recordings"], "readwrite", (t) => t.objectStore("recordings").put(rec)); },
  async allRecordings() {
    return this.tx(["recordings"], "readonly", (t) => this.req(t.objectStore("recordings").getAll()));
  },
  getRecording(id) { return this.tx(["recordings"], "readonly", (t) => this.req(t.objectStore("recordings").get(id))); },
  addChunk(chunk) { return this.tx(["chunks"], "readwrite", (t) => t.objectStore("chunks").add(chunk)); },
  chunks(recId) {
    return this.tx(["chunks"], "readonly", (t) => this.req(t.objectStore("chunks").index("recId").getAll(recId)));
  },
  async deleteRecording(id) {
    return this.tx(["recordings", "chunks"], "readwrite", (t) => {
      t.objectStore("recordings").delete(id);
      const idx = t.objectStore("chunks").index("recId");
      idx.openKeyCursor(IDBKeyRange.only(id)).onsuccess = (ev) => {
        const cur = ev.target.result;
        if (cur) { t.objectStore("chunks").delete(cur.primaryKey); cur.continue(); }
      };
    });
  },
};

/* ---------------- recorder ---------------- */

const recorder = {
  rec: null,        // recording metadata while active
  t0: 0,            // performance.now() at start
  pending: new Map(), // sensorKey -> array of Uint8Array rows
  flushTimer: null,
  bytes: 0,
  sinceFlush: 0,

  get active() { return !!this.rec; },

  sensorMeta(s) {
    return { key: s.key, name: s.name, short: s.short, module: s.module, source: s.source, calibration: s.cal };
  },

  async start(name, notes) {
    const now = new Date();
    this.rec = {
      id: now.toISOString() + "-" + Math.random().toString(36).slice(2, 7),
      name, notes, createdAt: now.toISOString(), status: "recording",
      durationMs: 0, sensors: [...sensors.values()].map((s) => this.sensorMeta(s)),
      markers: [], packets: {}, filters: { band: settings.band, notch: settings.notch },
      app: { version: APP_VERSION, userAgent: navigator.userAgent },
    };
    this.t0 = performance.now();
    this.bytes = 0;
    this.pending.clear();
    await db.putRecording(this.rec);
    this.flushTimer = setInterval(() => this.flush(), 1000);
    navigator.storage?.persist?.().catch(() => {});
    window.addEventListener("beforeunload", beforeUnload);
    keepAwake();
    updateRecordingUi();
  },

  sensorJoined(s) {
    if (!this.rec) return;
    if (!this.rec.sensors.some((m) => m.key === s.key)) this.rec.sensors.push(this.sensorMeta(s));
  },

  addPacket(s, hostTime, dv) {
    if (!this.rec) return;
    const row = new Uint8Array(REC_ROW_BYTES);
    new DataView(row.buffer).setFloat64(0, hostTime - this.t0, true);
    row.set(new Uint8Array(dv.buffer, dv.byteOffset, PACKET_BYTES), 8);
    let list = this.pending.get(s.key);
    if (!list) this.pending.set(s.key, (list = []));
    list.push(row);
    this.rec.packets[s.key] = (this.rec.packets[s.key] || 0) + 1;
    this.bytes += PACKET_BYTES;
    // timers are throttled when the page is in the background; data events are not
    if (++this.sinceFlush >= 25 * Math.max(1, sensors.size)) { this.sinceFlush = 0; this.flush(); }
  },

  addMarker(label) {
    if (!this.rec) return;
    this.rec.markers.push({ t: (performance.now() - this.t0) / 1000, label });
  },

  async flush() {
    if (!this.rec) return;
    const writes = [];
    for (const [key, rows] of this.pending) {
      if (!rows.length) continue;
      const data = new Uint8Array(rows.length * REC_ROW_BYTES);
      rows.forEach((r, i) => data.set(r, i * REC_ROW_BYTES));
      rows.length = 0;
      writes.push(db.addChunk({ recId: this.rec.id, sensorKey: key, data: data.buffer }));
    }
    for (const s of sensors.values()) {  // calibration and module can arrive after start
      const m = this.rec.sensors.find((x) => x.key === s.key);
      if (m) { m.module = s.module; m.calibration = s.cal; }
    }
    this.rec.durationMs = performance.now() - this.t0;
    writes.push(db.putRecording(this.rec));
    try { await Promise.all(writes); }
    catch (e) { showBanner(`Saving failed (${e.message}). Storage may be full; stop and download the recording.`, true); }
  },

  async stop() {
    if (!this.rec) return;
    clearInterval(this.flushTimer);
    await this.flush();
    this.rec.status = "done";
    await db.putRecording(this.rec);
    const id = this.rec.id;
    this.rec = null;
    window.removeEventListener("beforeunload", beforeUnload);
    updateRecordingUi();
    await renderRecordings(id);
  },
};

function beforeUnload(e) { e.preventDefault(); e.returnValue = ""; }

/* ---------------- export ---------------- */

/** Filters in old recordings were stored as { hp }; map them to a band preset. */
function recFilters(rec) {
  const f = rec.filters || {};
  return { band: f.band || (f.hp === 0 ? "wide" : "emg"), notch: f.notch ?? 50 };
}

/**
 * Rebuild each sensor's sample stream from stored packets, filter it in sensor order
 * (resetting only at real gaps), then place it on a shared 1 ms timeline.
 * The sensors' clocks run ~2-3% slow (≈975 Hz), so each sample's time comes from a
 * fit of packet arrival time against sequence number, not from a nominal 1 kHz.
 */
async function assemble(rec, filters) {
  const chunks = await db.chunks(rec.id);
  const bySensor = new Map();
  for (const c of chunks) {
    let arr = bySensor.get(c.sensorKey);
    if (!arr) bySensor.set(c.sensorKey, (arr = []));
    arr.push(new Uint8Array(c.data));
  }
  const series = [];
  for (const meta of rec.sensors) {
    const parts = bySensor.get(meta.key);
    if (!parts) continue;
    const rows = [];
    for (const p of parts) {
      for (let off = 0; off + REC_ROW_BYTES <= p.byteLength; off += REC_ROW_BYTES) rows.push(new DataView(p.buffer, off, REC_ROW_BYTES));
    }
    const n = rows.length;
    if (!n) continue;
    // unwrap the 24-bit sequence counter
    let prev = null, wraps = 0;
    const seqs = new Float64Array(n), hosts = new Float64Array(n);
    rows.forEach((r, i) => {
      const s = r.getUint8(9) | (r.getUint8(10) << 8) | (r.getUint8(11) << 16);
      if (prev !== null && s < prev && prev - s > 0x800000) wraps++;
      prev = s;
      seqs[i] = s + wraps * 0x1000000;
      hosts[i] = r.getFloat64(0, true);
    });
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
    const chain = new Chain(filters);
    chain.reset();
    let k = 0;
    for (let r = 0; r < n; r++) {
      const row = rows[r];
      if (r > 0 && seqs[r] !== seqs[r - 1] + 1) chain.reset();  // lost packets
      const tLast = offset + slope * seqs[r];
      let empty = true;
      for (let i = 0; i < PER_PACKET; i++) if (row.getUint16(14 + i * 2, true) !== 8192) { empty = false; break; }
      for (let i = 0; i < PER_PACKET; i++, k++) {
        t[k] = tLast - (PER_PACKET - 1 - i) * step;
        if (empty) { uv[k] = filt[k] = env[k] = NaN; continue; }  // battery-measurement packet
        const x = (row.getUint16(14 + i * 2, true) - 8192) * UV_PER_LSB;
        const [f, e] = chain.step(x);
        uv[k] = x; filt[k] = f; env[k] = e;
      }
      if (empty) chain.reset();
    }
    series.push({ meta, packets: n, slope, sampleRate: 1000 * PER_PACKET / slope, t, uv, filt, env });
  }
  if (!series.length) return { series, length: 0, tMin: 0 };
  let tMin = Infinity, tMax = -Infinity;
  for (const s of series) { tMin = Math.min(tMin, s.t[0]); tMax = Math.max(tMax, s.t[s.t.length - 1]); }
  tMin = Math.max(0, Math.floor(tMin)); // drop samples captured before Record was pressed
  const length = Math.max(0, Math.ceil(tMax - tMin) + 1);
  for (const s of series) {
    // grid cell -> sample index; a ~975 Hz stream leaves single empty cells, fill those
    const gi = new Int32Array(length).fill(-1);
    for (let k = 0; k < s.t.length; k++) {
      const idx = Math.round(s.t[k] - tMin);
      if (idx >= 0 && idx < length && gi[idx] < 0) gi[idx] = k;
    }
    for (let i = 1; i < length - 1; i++) if (gi[i] < 0 && gi[i - 1] >= 0 && gi[i + 1] >= 0 && gi[i + 1] - gi[i - 1] <= 1) gi[i] = gi[i - 1];
    s.gi = gi;
  }
  return { series, length, tMin };
}

const fmt = (v, d = 2) => (v === v ? v.toFixed(d) : "");

async function buildExport(rec) {
  const filters = recFilters(rec);
  const { series, length, tMin } = await assemble(rec, filters);
  const cols = ["time_s"];
  for (const s of series) {
    s.mvc = s.meta.calibration?.mvcRms;
    cols.push(`${s.meta.short}_raw_uV`, `${s.meta.short}_filtered_uV`, `${s.meta.short}_envelope_uV`);
    if (s.mvc) cols.push(`${s.meta.short}_pct_mvc`);
  }
  cols.push("marker");
  const markers = new Map();
  for (const m of rec.markers) {
    const idx = Math.max(0, Math.min(length - 1, Math.round(m.t * 1000 - tMin)));
    markers.set(idx, markers.has(idx) ? markers.get(idx) + "; " + m.label : m.label);
  }
  const parts = [cols.join(",") + "\n"];
  let lines = [];
  for (let i = 0; i < length; i++) {
    let line = ((tMin + i) / 1000).toFixed(3);
    let any = false;
    for (const s of series) {
      const k = s.gi[i];
      const r = k >= 0 ? s.uv[k] : NaN, f = k >= 0 ? s.filt[k] : NaN, e = k >= 0 ? s.env[k] : NaN;
      if (r === r) any = true;
      line += "," + fmt(r) + "," + fmt(f) + "," + fmt(e);
      if (s.mvc) line += "," + fmt(e / s.mvc * 100, 1);
    }
    const mk = markers.get(i);
    if (!any && !mk) continue;
    line += "," + (mk ? `"${mk.replace(/"/g, '""')}"` : "");
    lines.push(line);
    if (lines.length >= 20000) { parts.push(lines.join("\n") + "\n"); lines = []; }
  }
  if (lines.length) parts.push(lines.join("\n") + "\n");
  const base = fileBase(rec);
  const csv = new File(parts, base + ".csv", { type: "text/csv" });
  const band = BANDS[filters.band];
  const meta = {
    name: rec.name, notes: rec.notes, createdAt: rec.createdAt, status: rec.status,
    durationSeconds: +(rec.durationMs / 1000).toFixed(3),
    gridHz: FS, units: "microvolts (MYOblue_GUI scale: (raw - 8192) * 0.30518)",
    timeBase: "seconds since recording start, 1 ms rows; each sample is placed at its own time from the sensor's clock (fitted to packet arrival times)",
    filters: { preset: filters.band, label: band.label, highPassHz: band.hp, lowPassHz: band.lp || null, notchHz: filters.notch || null, envelope: `moving RMS, ${ENV_WINDOW} samples` },
    sensors: series.map((s) => ({
      column: s.meta.short, name: s.meta.name, module: s.meta.module, source: s.meta.source,
      packets: s.packets, measuredSampleRateHz: +s.sampleRate.toFixed(2),
      calibration: s.meta.calibration || null,
    })),
    markers: rec.markers,
    app: rec.app,
  };
  const json = new File([JSON.stringify(meta, null, 2)], base + ".json", { type: "application/json" });
  return { csv, json };
}

async function exportRecording(id, { share = false } = {}) {
  const rec = await db.getRecording(id);
  if (!rec) return;
  const item = document.querySelector(`[data-rec="${CSS.escape(id)}"]`);
  const status = item?.querySelector(".meta");
  const old = status?.textContent;
  if (status) status.textContent = "Preparing export…";
  await sleep(30);
  try {
    const { csv, json } = await buildExport(rec);
    if (share && navigator.canShare?.({ files: [csv, json] })) {
      await navigator.share({ files: [csv, json], title: rec.name });
    } else {
      download(csv); await sleep(400); download(json);
    }
  } catch (e) {
    if (e.name !== "AbortError") showBanner(`Export failed: ${e.message}`, true);
  } finally {
    if (status) status.textContent = old;
  }
}

function fileBase(rec) {
  const d = new Date(rec.createdAt);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const slug = rec.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "recording";
  return `myoblue_${stamp}_${slug}`;
}

function download(file) {
  const a = el("a", { href: URL.createObjectURL(file), download: file.name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/* ---------------- calibration wizard ---------------- */

const cal = {
  dialog: $("#calDialog"),
  running: false,

  open() {
    const live = [...sensors.values()].filter((s) => s.state === "live");
    if (!live.length) return;
    this.chosen = new Set(live.map((s) => s.key));
    this.results = new Map();
    const list = el("div", { className: "check-list" });
    for (const s of live) {
      const cb = el("input", { type: "checkbox", checked: true });
      cb.onchange = () => { cb.checked ? this.chosen.add(s.key) : this.chosen.delete(s.key); startBtn.disabled = !this.chosen.size; };
      const sw = el("span", { className: "swatch" }); sw.style.background = s.color;
      list.append(el("label", {}, cb, sw, s.name + (s.cal ? " (recalibrate)" : "")));
    }
    this.body(el("div", { className: "cal-step" },
      el("p", { textContent: "Calibration measures each sensor's resting noise and your maximum contraction. The app then shows live effort as % of maximum, marks when the muscle is active, and saves both values with every recording." }),
      el("p", { className: "muted small", textContent: "Place the sensors where you will record. Two steps of 5 seconds: relax completely, then contract as hard as you can." }),
      list));
    const startBtn = el("button", { className: "btn primary", textContent: "Start" });
    startBtn.onclick = () => this.run();
    this.buttons(this.cancelBtn(), startBtn);
    $("#calTitle").textContent = "Calibrate";
    $(".cal-progress", this.dialog).hidden = true;
    this.dialog.showModal();
  },

  body(...nodes) { $("#calBody").replaceChildren(...nodes); },
  buttons(...nodes) { $("#calButtons").replaceChildren(...nodes); },
  cancelBtn(label = "Cancel") {
    const b = el("button", { className: "btn", textContent: label });
    b.onclick = () => this.close();
    return b;
  },
  close() {
    this.running = false;
    this.hint = null;
    for (const s of sensors.values()) s.capture = null;
    this.dialog.close();
  },

  async phase(title, text, seconds, prep, hint) {
    $("#calTitle").textContent = title;
    this.body(el("div", { className: "cal-step" }, el("div", { className: "big", textContent: text })));
    const prog = $(".cal-progress", this.dialog);
    prog.hidden = false;
    const bar = $("#calBar"), count = $("#calCount");
    for (let i = prep; i > 0 && this.running; i--) {
      bar.style.width = "0"; count.textContent = `Get ready… ${i}`;
      await sleep(1000);
    }
    if (!this.running) return null;
    const chosen = [...this.chosen].map((k) => sensors.get(k)).filter(Boolean);
    const caps = new Map(chosen.map((s) => [s.key, (s.capture = [])]));
    this.hint = hint;
    const t0 = performance.now();
    while (this.running) {
      const t = (performance.now() - t0) / 1000;
      if (t >= seconds) break;
      bar.style.width = `${(t / seconds) * 100}%`;
      count.textContent = Math.ceil(seconds - t);
      await sleep(50);
    }
    for (const s of chosen) s.capture = null;
    this.hint = null;
    bar.style.width = "100%";
    return caps;
  },

  async run() {
    this.running = true;
    this.buttons(this.cancelBtn());
    const rest = await this.phase("Step 1 of 2: Rest", "Relax the muscle completely", 5, 3, "rest");
    if (!rest) return;
    const mvc = await this.phase("Step 2 of 2: Maximum contraction", "Contract as hard as you can and hold", 5, 3, "mvc");
    if (!mvc) return;
    this.running = false;
    $(".cal-progress", this.dialog).hidden = true;
    $("#calTitle").textContent = "Calibration results";

    const table = el("table", { className: "cal-table" });
    table.append(el("tr", {}, ...["Sensor", "Rest noise", "Max (MVC)", "Signal / noise", ""].map((h) => el("th", { textContent: h }))));
    const results = [];
    for (const key of this.chosen) {
      const s = sensors.get(key);
      if (!s) continue;
      const r = summarize(rest.get(key) || [], mvc.get(key) || []);
      if (!r) { table.append(el("tr", {}, el("td", { textContent: s.short }), el("td", { colSpan: 4, textContent: "No data received" }))); continue; }
      results.push([s, r]);
      const verdict = r.snrDb >= 20 ? ["good", "Good"] : r.snrDb >= 10 ? ["ok", "Usable"] : ["poor", "Check contact"];
      table.append(el("tr", {},
        el("td", { textContent: s.short }),
        el("td", { textContent: `${r.restRms.toFixed(1)} µV` }),
        el("td", { textContent: `${r.mvcRms.toFixed(0)} µV` }),
        el("td", { textContent: `${r.snrDb.toFixed(0)} dB` }),
        el("td", { className: "verdict " + verdict[0], textContent: verdict[1] })));
    }
    this.body(el("div", { className: "cal-step" }, table,
      el("p", { className: "muted small", textContent: "Signal / noise below 10 dB usually means poor skin contact or a sensor placed off the muscle belly. Rest noise is the RMS envelope while relaxed; MVC is the 95th percentile of the envelope during the contraction." })));
    const redo = el("button", { className: "btn", textContent: "Redo" });
    redo.onclick = () => this.run();
    const save = el("button", { className: "btn primary", textContent: "Save calibration", disabled: !results.length });
    save.onclick = () => {
      for (const [s, r] of results) {
        s.cal = { ...r, date: new Date().toISOString(), filters: { band: settings.band, notch: settings.notch } };
        calibration.set(s.name, s.cal);
        updateCardCal(s);
      }
      this.close();
    };
    this.buttons(this.cancelBtn("Discard"), redo, save);
  },
};

function percentile(arr, p) {
  if (!arr.length) return NaN;
  const a = Float64Array.from(arr).sort();
  return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
}

function summarize(rest, mvc) {
  if (rest.length < 500 || mvc.length < 500) return null;
  const restTrim = rest.slice(500);                // drop the first 0.5 s (settling)
  const mean = restTrim.reduce((a, b) => a + b, 0) / restTrim.length;
  const sd = Math.sqrt(restTrim.reduce((a, b) => a + (b - mean) ** 2, 0) / restTrim.length);
  const mvcRms = percentile(mvc, 0.95);
  const threshold = Math.max(mean + 3 * sd, mean * 1.5);
  return {
    restRms: mean, restSd: sd, mvcRms, threshold,
    snrDb: 20 * Math.log10(Math.max(mvcRms, 1e-6) / Math.max(mean, 1e-6)),
  };
}

/* ---------------- UI: sensor cards ---------------- */

function buildCard(s) {
  const card = el("article", { className: "card" });
  card.style.setProperty("--c", s.color);
  const state = el("span", { className: "pill warn", textContent: "Connecting…" });
  const active = el("span", { className: "pill active", textContent: "Active", hidden: true });
  const reconnect = el("button", { className: "btn small", textContent: "Reconnect", hidden: true });
  reconnect.onclick = () => connectBle(s);
  const remove = el("button", { className: "btn small", textContent: "Remove" });
  remove.onclick = () => removeSensor(s);
  const head = el("div", { className: "card-head" },
    el("span", { className: "swatch" }),
    el("div", {}, el("div", { className: "card-title", textContent: s.name.replace(/_/g, " ") }),
      el("div", { className: "card-sub", textContent: s.source === "demo" ? "Simulated signal" : "Bluetooth" })),
    state, active, el("span", { className: "spacer" }), el("div", { className: "card-menu" }, reconnect, remove));
  const b = (label) => { const v = el("b", { textContent: "–" }); return [el("span", {}, label + " ", v), v]; };
  const [batS, bat] = b("Battery"), [rateS, rate] = b("Rate"), [lossS, loss] = b("Lost"), [calS, calV] = b("Calibration");
  const stats = el("div", { className: "stats" }, batS, rateS, lossS, calS);
  const canvas = el("canvas");
  const plot = el("div", { className: "plot", title: "Tap to reset the peak-hold scale" }, canvas);
  plot.onclick = () => { s.hold = null; };
  const specCanvas = el("canvas");
  const spec = el("div", { className: "plot spectrum", hidden: !settings.spectrum }, specCanvas);
  const fill = el("div", { className: "meter-fill" });
  const thr = el("div", { className: "meter-thr", hidden: true });
  const meterVal = el("span", { className: "meter-val", textContent: "–" });
  const meter = el("div", { className: "meter" }, el("span", { textContent: "Effort" }), el("div", { className: "meter-track" }, fill, thr), meterVal);
  card.append(head, stats, plot, spec, meter);
  $("#sensors").append(card);
  const ui = { card, state, active, reconnect, bat, rate, loss, calV, canvas, spec, specCanvas, fill, thr, meterVal };
  s.ui = ui;
  updateCardCal(s);
  return ui;
}

function updateCardCal(s) {
  const c = s.cal;
  s.ui.calV.textContent = c ? `MVC ${c.mvcRms.toFixed(0)} µV · ${new Date(c.date).toLocaleDateString()}` : "not calibrated";
  s.ui.thr.hidden = !c;
  if (c) s.ui.thr.style.left = `${Math.min(100, c.threshold / c.mvcRms * 100)}%`;
}

let cssVars = {};
function readCssVars() {
  const cs = getComputedStyle(document.documentElement);
  cssVars = { grid: cs.getPropertyValue("--grid").trim(), muted: cs.getPropertyValue("--muted").trim(),
    line: cs.getPropertyValue("--line").trim(), ink: cs.getPropertyValue("--ink").trim() };
  for (const s of sensors.values()) s.colorResolved = getComputedStyle(s.ui.card).getPropertyValue("--c").trim();
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", readCssVars);

function prepCanvas(c) {
  const dpr = Math.min(devicePixelRatio || 1, 2), W = c.clientWidth, H = c.clientHeight;
  if (!W || !H) return null;
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  return { g, W, H };
}

/** Column-wise min/max of the newest n samples of a ring buffer. */
function columns(buf, w, n, cols) {
  const start = (w - n + RING) % RING, per = n / cols;
  const mins = new Float32Array(cols), maxs = new Float32Array(cols);
  let lo = Infinity, hi = -Infinity;
  for (let x = 0; x < cols; x++) {
    let mn = Infinity, mx = -Infinity;
    const a = Math.floor(x * per), b = Math.floor((x + 1) * per);
    for (let i = a; i < b; i++) { const v = buf[(start + i) % RING]; if (v === v) { if (v < mn) mn = v; if (v > mx) mx = v; } }
    mins[x] = mn; maxs[x] = mx;
    if (mn < lo) lo = mn; if (mx > hi) hi = mx;
  }
  return { mins, maxs, lo, hi };
}

function yRange(s, mode, lo, hi) {
  const envelope = mode === "envelope", sc = settings.scale;
  let ymin, ymax;
  if (sc === "mvc" && s.cal) {                  // fit to calibrated maximum: whole effort range visible
    ymax = envelope ? s.cal.mvcRms * 1.25 : s.cal.mvcRms * 3.5;
    ymin = envelope ? 0 : -ymax;
  } else if (sc !== "auto" && sc !== "hold" && sc !== "mvc") {
    ymax = +sc; ymin = envelope ? 0 : -ymax;
  } else if (lo === Infinity) { ymax = 50; ymin = envelope ? 0 : -50; }
  else if (envelope) { ymin = 0; ymax = Math.max(hi * 1.15, 10); }
  else if (mode === "raw") { const pad = Math.max((hi - lo) * 0.1, 5); ymin = lo - pad; ymax = hi + pad; }
  else { const m = Math.max(Math.abs(lo), Math.abs(hi), 10) * 1.15; ymin = -m; ymax = m; }
  if (sc === "hold" || (sc === "mvc" && !s.cal)) {  // peak hold: only ever grows, tap the plot to reset
    const key = mode;
    if (!s.hold || s.hold.key !== key) s.hold = { key, ymin, ymax };
    s.hold.ymin = Math.min(s.hold.ymin, ymin); s.hold.ymax = Math.max(s.hold.ymax, ymax);
    ymin = s.hold.ymin; ymax = s.hold.ymax;
  }
  return [ymin, ymax];
}

function drawSensor(s) {
  const p = prepCanvas(s.ui.canvas);
  if (!p) return;
  const { g, W, H } = p;
  const rate = s.rate > 500 ? s.rate : FS;
  const n = Math.min(RING, Math.round(settings.win * rate));
  const mode = settings.viewMode;
  const buf = mode === "raw" ? s.raw : mode === "envelope" ? s.env : s.filt;
  const cols = Math.max(1, Math.floor(W));
  const { mins, maxs, lo, hi } = columns(buf, s.w, n, cols);
  const envelope = mode === "envelope";
  const overlay = settings.overlay && mode === "filtered" ? columns(s.env, s.w, n, cols) : null;
  const [ymin, ymax] = yRange(s, mode, lo, overlay ? Math.max(hi, overlay.hi) : hi);
  const top = 6, bottom = H - 6;
  const Y = (v) => bottom - (Math.max(ymin, Math.min(ymax, v)) - ymin) / (ymax - ymin) * (bottom - top);

  // grid: zero line, 1 s ticks
  g.strokeStyle = cssVars.grid; g.lineWidth = 1; g.beginPath();
  for (let sec = 1; sec < settings.win; sec++) { const x = Math.round(W * sec / settings.win) + 0.5; g.moveTo(x, top); g.lineTo(x, bottom); }
  if (ymin < 0 && ymax > 0) { const y = Math.round(Y(0)) + 0.5; g.moveTo(0, y); g.lineTo(W, y); }
  g.stroke();
  if (envelope && s.cal) {  // activity threshold
    const y = Y(s.cal.threshold);
    g.strokeStyle = cssVars.muted; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); g.setLineDash([]);
  }
  // signal
  g.strokeStyle = s.colorResolved || "#2458d6"; g.lineWidth = 1.3; g.lineJoin = "round";
  g.globalAlpha = overlay ? 0.75 : 1;
  g.beginPath();
  let pen = false;
  for (let x = 0; x < cols; x++) {
    if (mins[x] === Infinity) { pen = false; continue; }
    const y1 = Y(mins[x]), y2 = Y(maxs[x]);
    if (!pen) { g.moveTo(x, y1); pen = true; } else g.lineTo(x, y1);
    if (y2 !== y1) g.lineTo(x, y2);
  }
  g.stroke();
  g.globalAlpha = 1;
  // envelope overlay (±RMS), like the envelope/RMS lines in MYOblue_GUI
  if (overlay) {
    g.strokeStyle = cssVars.ink; g.lineWidth = 1.6;
    for (const sign of [1, -1]) {
      g.beginPath(); pen = false;
      for (let x = 0; x < cols; x++) {
        const v = overlay.maxs[x];
        if (v === -Infinity) { pen = false; continue; }
        const y = Y(sign * v);
        if (!pen) { g.moveTo(x, y); pen = true; } else g.lineTo(x, y);
      }
      g.stroke();
    }
  }
  // labels
  g.fillStyle = cssVars.muted; g.font = "11px ui-sans-serif, system-ui, sans-serif";
  const unit = (v) => Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)} mV` : `${Math.round(v)} µV`;
  g.fillText(unit(ymax), 8, 16);
  if (!envelope) g.fillText(unit(ymin), 8, H - 10);
  const tag = settings.scale === "hold" || (settings.scale === "mvc" && !s.cal) ? "peak hold · tap to reset"
    : settings.scale === "mvc" ? "scaled to MVC" : "";
  if (tag) { g.textAlign = "right"; g.fillText(tag, W - 8, 16); g.textAlign = "left"; }
}

/* ---- spectrum (FFT of the newest 1024 filtered samples) ---- */

const FFT_N = 1024;
const HANN = Float64Array.from({ length: FFT_N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_N - 1)));
function fftMag(input) {
  const n = input.length, re = Float64Array.from(input), im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
  const mag = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

function drawSpectrum(s, now) {
  if (!settings.spectrum) return;
  if (!s.specAt || now - s.specAt > 250) {
    const src = settings.viewMode === "raw" ? s.raw : s.filt;
    const x = new Float64Array(FFT_N);
    let mean = 0, count = 0;
    for (let i = 0; i < FFT_N; i++) { const v = src[(s.w - FFT_N + i + RING) % RING]; if (v === v) { mean += v; count++; } }
    mean = count ? mean / count : 0;
    for (let i = 0; i < FFT_N; i++) { const v = src[(s.w - FFT_N + i + RING) % RING]; x[i] = (v === v ? v - mean : 0) * HANN[i]; }
    const mag = fftMag(x);
    s.spec = s.spec ? s.spec.map((v, i) => 0.6 * v + 0.4 * mag[i]) : mag;  // light smoothing
    s.specAt = now;
  }
  const p = prepCanvas(s.ui.specCanvas);
  if (!p || !s.spec) return;
  const { g, W, H } = p;
  const rate = s.rate > 500 ? s.rate : FS, nyq = rate / 2, bins = s.spec.length;
  let peak = 1e-9;
  for (let i = 2; i < bins; i++) peak = Math.max(peak, s.spec[i]);
  const top = 6, bottom = H - 16;
  const Y = (v) => { const db = 20 * Math.log10(Math.max(v, 1e-9) / peak); return top + Math.min(1, -db / 50) * (bottom - top); };
  g.strokeStyle = cssVars.grid; g.lineWidth = 1; g.beginPath();
  g.fillStyle = cssVars.muted; g.font = "10px ui-sans-serif, system-ui, sans-serif";
  for (let f = 0; f <= 500; f += 100) {
    const x = Math.round(f / nyq * (W - 1)) + 0.5;
    g.moveTo(x, top); g.lineTo(x, bottom);
    g.textAlign = f === 0 ? "left" : f === 500 ? "right" : "center";
    g.fillText(f + (f === 500 ? " Hz" : ""), Math.min(W - 2, x), H - 3);
  }
  g.stroke(); g.textAlign = "left";
  g.fillStyle = s.colorResolved || "#2458d6"; g.globalAlpha = 0.35;
  g.beginPath(); g.moveTo(0, bottom);
  for (let i = 1; i < bins; i++) g.lineTo(i / (bins - 1) * W, Y(s.spec[i]));
  g.lineTo(W, bottom); g.closePath(); g.fill();
  g.globalAlpha = 1; g.strokeStyle = s.colorResolved || "#2458d6"; g.lineWidth = 1.2; g.beginPath();
  for (let i = 1; i < bins; i++) { const x = i / (bins - 1) * W, y = Y(s.spec[i]); i === 1 ? g.moveTo(x, y) : g.lineTo(x, y); }
  g.stroke();
  // dominant frequency
  let best = 2;
  for (let i = 2; i < bins; i++) if (s.spec[i] > s.spec[best]) best = i;
  g.fillStyle = cssVars.muted; g.textAlign = "right";
  g.fillText(`peak ${(best * rate / FFT_N).toFixed(0)} Hz`, W - 8, 14); g.textAlign = "left";
}

function updateCardStats(s, now) {
  s.ui.bat.textContent = s.battery ? `${s.battery.toFixed(2)} V` : "–";
  s.ui.bat.className = s.battery && s.battery < 2.5 ? "low" : "";
  s.ui.rate.textContent = s.rate ? `${Math.round(s.rate)} Hz` : "–";
  s.ui.loss.textContent = `${s.lossPct.toFixed(s.lossPct < 10 ? 1 : 0)}%`;
  if (s.state === "live" && now - s.lastPacketAt > 2000) setState(s, "stalled");
  const e = s.envNow;
  if (s.cal && e === e) {
    const pct = e / s.cal.mvcRms * 100;
    s.ui.fill.style.width = `${Math.min(100, pct)}%`;
    s.ui.meterVal.textContent = `${pct.toFixed(0)}% MVC`;
    s.ui.active.hidden = !(e > s.cal.threshold) || s.state !== "live";
  } else {
    s.ui.fill.style.width = e === e ? `${Math.min(100, e / 5)}%` : "0";
    s.ui.meterVal.textContent = e === e ? `${e.toFixed(0)} µV` : "–";
    s.ui.active.hidden = true;
  }
}

let lastStats = 0;
function frame(now) {
  for (const s of sensors.values()) { drawSensor(s); drawSpectrum(s, now); }
  if (now - lastStats > 250) {
    for (const s of sensors.values()) {
      if (!s.rateT) s.rateT = now;
      if (now - s.rateT >= 2000) {  // average over 2 s; packets arrive in bursts
        s.rate = (s.rateCount * PER_PACKET) / ((now - s.rateT) / 1000);
        s.rateCount = 0; s.rateT = now;
      }
      updateCardStats(s, now);
    }
    lastStats = now;
    if (recorder.active) $("#recTime").textContent = clock((now - recorder.t0) / 1000);
  }
  requestAnimationFrame(frame);
}

const clock = (sec) => {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
};

/* ---------------- UI: layout and actions ---------------- */

function updateLayout() {
  $("#empty").hidden = sensors.size > 0;
  readCssVars();
  updateActions();
}

function updateActions() {
  const anyLive = [...sensors.values()].some((s) => s.state === "live");
  document.querySelectorAll('[data-action="calibrate"]').forEach((b) => (b.disabled = !anyLive || recorder.active));
  document.querySelectorAll('[data-action="record"]').forEach((b) => (b.disabled = !sensors.size));
}

function updateRecordingUi() {
  const on = recorder.active;
  $(".idle-actions").hidden = on;
  $(".rec-actions").hidden = !on;
  $("#recBadge").hidden = !on;
  if (on) renderMarkerChips();
  updateActions();
}

function markerLabels() {
  return settings.markerLabels.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 8);
}

function renderMarkerChips() {
  const chips = $("#markerChips");
  chips.replaceChildren();
  let count = 0;
  const mk = (label, text = label) => {
    const b = el("button", { className: "chip", textContent: text });
    b.onclick = () => {
      const l = label || `mark ${++count}`;
      recorder.addMarker(l);
      b.classList.add("flash"); setTimeout(() => b.classList.remove("flash"), 250);
      if (navigator.vibrate) navigator.vibrate(30);
    };
    return b;
  };
  chips.append(mk(null, "＋ Mark"));
  for (const l of markerLabels()) chips.append(mk(l));
}

function showBanner(text, error = false) {
  const b = $("#banner");
  b.textContent = text;
  b.hidden = !text;
  b.classList.toggle("error", error);
}

async function openRecordDialog() {
  const d = $("#recDialog");
  const now = new Date();
  $("#recName").value = `Session ${now.toLocaleDateString()} ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  $("#recNotes").value = store.get("lastNotes", "");
  const list = [...sensors.values()];
  const uncal = list.filter((s) => !s.cal).map((s) => s.short);
  $("#recCalNote").textContent = uncal.length
    ? `Not calibrated: ${uncal.join(", ")}. You can still record; % MVC columns are added only for calibrated sensors.`
    : "All sensors calibrated. Calibration values are saved with the recording.";
  d.returnValue = "";
  d.showModal();
  d.addEventListener("close", async () => {
    if (d.returnValue !== "start") return;
    store.set("lastNotes", $("#recNotes").value);
    await recorder.start($("#recName").value.trim() || "Recording", $("#recNotes").value.trim());
  }, { once: true });
}

async function renderRecordings(highlight) {
  const list = $("#recList");
  let recs = [];
  try { recs = await db.allRecordings(); } catch (e) { showBanner(`Can't open browser storage: ${e.message}`, true); }
  recs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $("#recEmpty").hidden = recs.length > 0;
  list.replaceChildren(...recs.map((r) => {
    const packets = Object.values(r.packets || {}).reduce((a, b) => a + b, 0);
    const size = packets * PACKET_BYTES;
    const meta = [new Date(r.createdAt).toLocaleString(), clock(r.durationMs / 1000),
      `${r.sensors.length} sensor${r.sensors.length === 1 ? "" : "s"}`, `${r.markers.length} marker${r.markers.length === 1 ? "" : "s"}`,
      size < 1e6 ? `${Math.max(1, Math.round(size / 1e3))} KB` : `${(size / 1e6).toFixed(size < 1e7 ? 1 : 0)} MB`].join(" · ");
    const dl = el("button", { className: "btn small primary", textContent: "Download CSV + JSON" });
    dl.onclick = () => exportRecording(r.id);
    const buttons = [dl];
    if (navigator.canShare) {
      const sh = el("button", { className: "btn small", textContent: "Share" });
      sh.onclick = () => exportRecording(r.id, { share: true });
      buttons.push(sh);
    }
    const del = el("button", { className: "btn small danger", textContent: "Delete" });
    let armed = null;
    del.onclick = async () => {
      if (!armed) {
        del.textContent = "Tap again to delete";
        armed = setTimeout(() => { del.textContent = "Delete"; armed = null; }, 3000);
        return;
      }
      clearTimeout(armed);
      await db.deleteRecording(r.id);
      renderRecordings();
      updateStorage();
    };
    buttons.push(del);
    const statusPill = r.status === "recording" && r.id !== recorder.rec?.id
      ? el("span", { className: "pill warn", textContent: "Interrupted", title: "The tab closed while recording. Everything saved up to that point is kept." })
      : r.id === recorder.rec?.id ? el("span", { className: "pill bad", textContent: "Recording" }) : "";
    const li = el("li", { className: "rec-item" },
      el("div", { className: "top" }, el("span", { className: "name", textContent: r.name }), statusPill),
      el("div", { className: "meta", textContent: meta }),
      r.notes ? el("div", { className: "notes", textContent: r.notes }) : "",
      el("div", { className: "row" }, ...buttons));
    li.dataset.rec = r.id;
    if (r.id === highlight) li.style.borderColor = "var(--accent)";
    return li;
  }));
  updateStorage();
}

async function updateStorage() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) $("#storage").textContent = `${(est.usage / 1e6).toFixed(1)} MB used of ${(est.quota / 1e9).toFixed(1)} GB available`;
  } catch {}
}

let wakeLock = null;
async function keepAwake() {
  try {
    if (!wakeLock && "wakeLock" in navigator && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (sensors.size || recorder.active)) keepAwake();
  else if (recorder.active) recorder.flush();
});

/* ---------------- settings panel ---------------- */

function bindSettings() {
  const panel = $("#settings"), btn = $("#settingsBtn");
  const show = (open) => { panel.hidden = !open; btn.setAttribute("aria-expanded", String(open)); };
  show(store.get("settingsOpen", matchMedia("(min-width: 700px)").matches));  // open by default on wide screens
  btn.onclick = () => { show(panel.hidden); store.set("settingsOpen", !panel.hidden); };
  const bind = (id, key, num = true) => {
    const input = $("#" + id), check = input.type === "checkbox";
    if (check) input.checked = !!settings[key]; else input.value = String(settings[key]);
    input.addEventListener("change", () => {
      settings[key] = check ? input.checked : num ? +input.value : input.value;
      saveSettings();
      if (key === "band" || key === "notch") for (const s of sensors.values()) s.rebuildChain();
      if (key === "scale" || key === "viewMode") for (const s of sensors.values()) s.hold = null;
      if (key === "spectrum") for (const s of sensors.values()) s.ui.spec.hidden = !settings.spectrum;
      if (key === "markerLabels" && recorder.active) renderMarkerChips();
    });
  };
  bind("viewMode", "viewMode", false); bind("band", "band", false); bind("scale", "scale", false);
  bind("notch", "notch"); bind("win", "win");
  bind("overlay", "overlay"); bind("spectrum", "spectrum");
  bind("markerLabels", "markerLabels", false);
}

/* ---------------- boot ---------------- */

const APP_VERSION = "1.1.0";

function boot() {
  bindSettings();
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-action]")?.dataset.action;
    if (!a) return;
    if (a === "connect") addBleSensor();
    if (a === "demo") addDemoSensor();
    if (a === "calibrate") cal.open();
    if (a === "record") openRecordDialog();
    if (a === "stop") recorder.stop();
  });
  document.addEventListener("keydown", (e) => {
    if (!recorder.active || e.target.closest("input, textarea, select, dialog")) return;
    if (e.key === "m" || e.key === "M") { recorder.addMarker("mark"); }
  });
  if (!navigator.bluetooth) {
    showBanner(isSecureContext
      ? "This browser can't use Bluetooth. Use Chrome on Android, Chrome or Edge on a computer, or Bluefy on iPhone. The demo sensor works anywhere."
      : "Bluetooth needs a secure page. Open this app over https:// (or http://localhost).", true);
    document.querySelectorAll('[data-action="connect"]').forEach((b) => (b.disabled = true));
  }
  if (new URLSearchParams(location.search).has("demo")) addDemoSensor();
  restoreBleSensors();
  updateLayout();
  updateRecordingUi();
  renderRecordings();
  requestAnimationFrame(frame);
  if ("serviceWorker" in navigator && isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});
}

boot();
