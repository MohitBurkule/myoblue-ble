// Run: npx tsx tests/core.test.ts
import assert from "node:assert/strict";
import { DemoSensor, DEMO_RATE } from "../src/core/demo";
import { base64ToBytes, bytesToBase64, parsePacket, PACKET_BYTES, ROW_BYTES, seqGap } from "../src/core/protocol";
import { alignGrid, buildSeries, segmentStats, writeCsv, type Marker, type SensorMeta } from "../src/core/session";
import { summarize } from "../src/core/calibration";
import { Chain, spectrum, FFT_N } from "../src/core/dsp";

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log("ok -", name); };

test("base64 round trip", () => {
  for (const len of [0, 1, 2, 3, 244]) {
    const b = Uint8Array.from({ length: len }, (_, i) => (i * 37) & 255);
    assert.deepEqual(base64ToBytes(bytesToBase64(b)), b);
  }
  assert.equal(bytesToBase64(new Uint8Array([1, 2, 3, 4])), Buffer.from([1, 2, 3, 4]).toString("base64"));
});

test("parse packet", () => {
  const d = new DemoSensor(2);
  const p = parsePacket(d.next())!;
  assert.equal(p.module, 2);
  assert.equal(p.seq, 0);
  assert.ok(Math.abs(p.battery - 3.0) < 0.01);
  assert.equal(p.uv.length, 119);
  assert.equal(seqGap(0xffffff, 0), 0);
  assert.equal(seqGap(5, 9), 3);
});

/** Simulate a recording: rows = float64 host ms + packet, with arrival jitter and a lost packet. */
function record(seconds: number, module: number, lose = new Set<number>()) {
  const d = new DemoSensor(module);
  const nPackets = Math.floor((seconds * DEMO_RATE) / 119);
  const rows: Uint8Array[] = [];
  for (let i = 0; i < nPackets; i++) {
    const pkt = d.next();
    if (lose.has(i)) continue;
    const row = new Uint8Array(ROW_BYTES);
    const host = (i + 1) * DemoSensor.INTERVAL + 5 + Math.random() * 25; // BLE latency 5-30 ms
    new DataView(row.buffer).setFloat64(0, host, true);
    row.set(pkt, 8);
    rows.push(row);
  }
  const out = new Uint8Array(rows.length * ROW_BYTES);
  rows.forEach((r, i) => out.set(r, i * ROW_BYTES));
  return out;
}

const meta = (id: string, short: string): SensorMeta => ({ id, name: `${short.slice(1)}_MYOblue_demo`, short, calibration: null });

test("series: clock fit recovers ~976 Hz and filters stay continuous", () => {
  const bytes = record(60, 1, new Set([100]));
  const s = buildSeries(meta("a", "S1"), bytes, { band: "emg", notch: 50 })!;
  assert.ok(Math.abs(s.sampleRate - DEMO_RATE) < 3, `rate ${s.sampleRate}`);
  const filled = s.filt.reduce((n, v) => n + (v === v ? 1 : 0), 0);
  // missing: settle after start (300) + after the lost packet (300) + battery packet (119 + 300)
  assert.ok(filled / s.filt.length > 0.97, `filtered fraction ${filled / s.filt.length}`);
});

test("grid: rows every ms, both sensors aligned, markers placed", () => {
  const s1 = buildSeries(meta("a", "S1"), record(20, 1), { band: "emg", notch: 50 })!;
  const s2 = buildSeries(meta("b", "S2"), record(20, 2), { band: "wide", notch: 50 })!;
  const grid = alignGrid([s1, s2]);
  const markers: Marker[] = [{ t: 5, label: "contract" }, { t: 12.5, label: 'say "hi"' }];
  let csv = "";
  writeCsv([s1, s2], grid, markers, (c) => (csv += c), 5000);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "time_s,S1_raw_uV,S1_filtered_uV,S1_envelope_uV,S2_raw_uV,S2_filtered_uV,S2_envelope_uV,marker");
  const rows = lines.slice(1).map((l) => l.split(","));
  let both = 0, filt = 0, prev = -1, mono = true;
  for (const r of rows) {
    if (r[1] !== "" && r[4] !== "") both++;
    if (r[2] !== "") filt++;
    const t = +r[0];
    if (!(t > prev)) mono = false;
    prev = t;
  }
  assert.ok(mono, "time increases");
  assert.ok(both / rows.length > 0.98, `rows with both sensors ${both / rows.length}`);
  assert.ok(filt / rows.length > 0.95, `rows with filtered ${filt / rows.length}`);
  const mk = lines.filter((l) => l.endsWith('"'));
  assert.equal(mk.length, 2);
  assert.ok(mk[0].startsWith("5.000,"), mk[0]);
  assert.ok(mk[1].endsWith('"say ""hi"""'), mk[1]);
});

test("calibration from demo rest/MVC", () => {
  const d = new DemoSensor(1);
  const chain = new Chain({ band: "emg", notch: 50 });
  const run = (hint: "rest" | "mvc", ms: number) => {
    d.hint = hint;
    const out: number[] = [];
    for (let i = 0; i < ms / DemoSensor.INTERVAL; i++) {
      for (const v of parsePacket(d.next())!.uv) { chain.step(v); if (chain.envelope === chain.envelope) out.push(chain.envelope); }
    }
    return out;
  };
  run("rest", 1000);
  const cal = summarize(run("rest", 5000), run("mvc", 5000), { band: "emg", notch: 50 })!;
  assert.ok(cal.snrDb > 20, `snr ${cal.snrDb}`);
  assert.ok(cal.threshold > cal.restRms && cal.threshold < cal.mvcRms);
});

test("segment stats with calibration", () => {
  const m = meta("a", "S1");
  m.calibration = { restRms: 3, restSd: 1, mvcRms: 150, threshold: 8, snrDb: 34, date: "", filters: { band: "emg", notch: 50 } };
  const s = buildSeries(m, record(20, 1), { band: "emg", notch: 50 })!;
  const st = segmentStats([s], [{ t: 10, label: "trial" }], 20);
  assert.deepEqual(st.map((x) => x.label), ["start", "trial"]);
  assert.ok(st[0].perSensor[0].meanPct! > 0 && st[0].perSensor[0].peakPct! > st[0].perSensor[0].meanPct!);
  assert.ok(st[0].perSensor[0].activePct! >= 0 && st[0].perSensor[0].activePct! <= 100);
});

test("spectrum shows ECG/hum peaks with wide band", () => {
  const d = new DemoSensor(1);
  const chain = new Chain({ band: "wide", notch: 0 });
  const ring = new Float32Array(4096);
  let w = 0;
  for (let p = 0; p < 40; p++) for (const v of parsePacket(d.next())!.uv) { chain.step(v); ring[w] = chain.filtered; w = (w + 1) % ring.length; }
  const mag = spectrum(ring, w);
  assert.equal(mag.length, FFT_N / 2);
  const bin50 = Math.round((50 * FFT_N) / DEMO_RATE);
  const around = Math.max(...Array.from(mag.slice(bin50 - 2, bin50 + 3)));
  const band = Array.from(mag.slice(Math.round((150 * FFT_N) / DEMO_RATE), Math.round((450 * FFT_N) / DEMO_RATE))).sort((a, b) => a - b);
  const median = band[band.length >> 1];
  assert.ok(around > median * 5, `50 Hz hum visible without notch (${around.toFixed(0)} vs median ${median.toFixed(0)})`);
});

assert.equal(PACKET_BYTES, 244);
console.log(`\n${passed} tests passed`);
