/** Simulated MYOblue sensor: EMG bursts, ECG pickup, mains hum, drift, battery packets, ~976 Hz. */
import { BATTERY_V_PER_LSB, PACKET_BYTES, PER_PACKET, UV_PER_LSB } from "./protocol";

export const DEMO_RATE = 976;

export type DemoHint = "rest" | "mvc" | null;

export class DemoSensor {
  private seq = 0;
  private t = 0;
  private burstAmp = 0;
  private burstUntil = 0;
  private nextBurst = 1500 + Math.random() * 1500;
  private lp = 0;
  private phase = Math.random() * 6;
  private buf = new Uint8Array(PACKET_BYTES);
  private dv = new DataView(this.buf.buffer);
  /** set by the calibration flow so the demo behaves like a cooperative subject */
  hint: DemoHint = null;

  constructor(readonly module: number) {}

  /** ms between packets */
  static readonly INTERVAL = (PER_PACKET * 1000) / DEMO_RATE;

  next(): Uint8Array {
    const { dv, buf } = this;
    const seq = this.seq;
    buf[0] = this.module;
    buf[1] = seq & 255; buf[2] = (seq >> 8) & 255; buf[3] = (seq >> 16) & 255;
    dv.setUint16(4, Math.round((3.0 - seq * 1e-6) / BATTERY_V_PER_LSB), true);
    const batteryPacket = seq > 0 && seq % 492 === 0; // about once a minute, like the real sensor
    for (let i = 0; i < PER_PACKET; i++, this.t++) {
      const t = this.t;
      if (this.hint === "rest") { this.burstUntil = 0; this.nextBurst = t + 800; }
      else if (this.hint === "mvc") { this.burstAmp = 300; this.burstUntil = t + 200; this.nextBurst = t + 1e9; }
      else if (this.nextBurst > t + 1e8) this.nextBurst = t + 1000;
      if (t >= this.nextBurst) {
        this.burstAmp = 60 + Math.random() * 260;
        this.burstUntil = t + 600 + Math.random() * 900;
        this.nextBurst = this.burstUntil + 1200 + Math.random() * 2500;
      }
      const ramp = t < this.burstUntil ? Math.min(1, (this.burstUntil - t) / 150) : 0;
      const g = (Math.random() + Math.random() + Math.random() - 1.5) * 1.6;
      this.lp = 0.55 * this.lp + 0.45 * g;
      const emg = (g - this.lp) * this.burstAmp * ramp;
      const beat = (t % 850) - 60;
      const ecg = 110 * Math.exp(-(beat * beat) / 60) - 25 * Math.exp(-((beat - 12) ** 2) / 40) + 22 * Math.exp(-((beat - 260) ** 2) / 2500);
      const uv = emg + ecg + g * 4 + 18 * Math.sin((2 * Math.PI * 50 * t) / DEMO_RATE + this.phase) + 40 * Math.sin((2 * Math.PI * 0.3 * t) / DEMO_RATE);
      const raw = batteryPacket ? 8192 : Math.max(0, Math.min(16383, Math.round(8192 + uv / UV_PER_LSB)));
      dv.setUint16(6 + i * 2, raw, true);
    }
    this.seq = (seq + 1) & 0xffffff;
    return buf.slice();
  }
}
