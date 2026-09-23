/** Streaming filters: band preset + mains notch + moving-RMS envelope. */

export type BandId = "emg" | "wide" | "ecg";

export interface Band {
  id: BandId;
  label: string;
  short: string;
  hp: number;
  order: 2 | 4;
  lp?: number;
}

/** "wide" matches MYOblue_GUI's default band-pass (2-480 Hz), which keeps ECG visible. */
export const BANDS: Record<BandId, Band> = {
  emg: { id: "emg", label: "EMG · 20 Hz high-pass", short: "EMG", hp: 20, order: 4 },
  wide: { id: "wide", label: "Wide · 2–480 Hz (as MYOblue GUI)", short: "Wide", hp: 2, order: 2, lp: 480 },
  ecg: { id: "ecg", label: "ECG · 0.5–40 Hz", short: "ECG", hp: 0.5, order: 2, lp: 40 },
};

export interface FilterSettings {
  band: BandId;
  notch: 0 | 50 | 60;
}

export const ENV_WINDOW = 100; // samples (~100 ms)
const SETTLE = 300; // samples to discard after a reset while filters settle
const BUTTERWORTH_Q: Record<2 | 4, number[]> = { 2: [0.7071], 4: [0.5412, 1.3066] };

type Stage = ((x: number) => number) & { reset: () => void };

function biquad(type: "hp" | "lp" | "notch", f0: number, q: number, fs: number): Stage {
  const w = (2 * Math.PI * f0) / fs, c = Math.cos(w), alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  let b0: number, b1: number, b2: number;
  if (type === "hp") { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
  else if (type === "lp") { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
  else { b0 = 1; b1 = -2 * c; b2 = 1; }
  const k0 = b0 / a0, k1 = b1 / a0, k2 = b2 / a0, k3 = (-2 * c) / a0, k4 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const f = ((x: number) => {
    const y = k0 * x + k1 * x1 + k2 * x2 - k3 * y1 - k4 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  }) as Stage;
  f.reset = () => { x1 = x2 = y1 = y2 = 0; };
  return f;
}

export class Chain {
  private stages: Stage[] = [];
  private win = new Float64Array(ENV_WINDOW);
  private wi = 0;
  private acc = 0;
  private settle = SETTLE;
  /** last computed values */
  filtered = NaN;
  envelope = NaN;

  constructor({ band, notch }: FilterSettings, fs = 975) {
    const b = BANDS[band] ?? BANDS.emg;
    for (const q of BUTTERWORTH_Q[b.order]) this.stages.push(biquad("hp", b.hp, q, fs));
    if (b.lp && b.lp < fs / 2) for (const q of BUTTERWORTH_Q[4]) this.stages.push(biquad("lp", b.lp, q, fs));
    if (notch) {
      for (const h of [1, 2, 3]) {
        const f = notch * h;
        if ((!b.lp || f < b.lp) && f < fs / 2 - 5) this.stages.push(biquad("notch", f, 8, fs));
      }
    }
  }

  reset() {
    for (const s of this.stages) s.reset();
    this.win.fill(0);
    this.acc = 0;
    this.wi = 0;
    this.settle = SETTLE;
  }

  /** Feed one sample (µV). Sets `filtered` and `envelope` (NaN while settling). */
  step(x: number) {
    let y = x;
    for (const s of this.stages) y = s(y);
    const sq = y * y;
    this.acc += sq - this.win[this.wi];
    this.win[this.wi] = sq;
    this.wi = (this.wi + 1) % ENV_WINDOW;
    if (this.settle > 0) {
      this.settle--;
      this.filtered = this.envelope = NaN;
      return;
    }
    this.filtered = y;
    this.envelope = Math.sqrt(Math.max(this.acc, 0) / ENV_WINDOW);
  }
}

/* ---- spectrum ---- */

export const FFT_N = 1024;
const HANN = Float64Array.from({ length: FFT_N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_N - 1)));

/** Magnitude spectrum of the newest FFT_N samples of a ring buffer (NaN treated as 0, mean removed). */
export function spectrum(ring: Float32Array, w: number): Float32Array {
  const n = FFT_N, R = ring.length;
  const re = new Float64Array(n), im = new Float64Array(n);
  let mean = 0, count = 0;
  for (let i = 0; i < n; i++) { const v = ring[(w - n + i + R) % R]; if (v === v) { mean += v; count++; } }
  mean = count ? mean / count : 0;
  for (let i = 0; i < n; i++) { const v = ring[(w - n + i + R) % R]; re[i] = (v === v ? v - mean : 0) * HANN[i]; }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  const mag = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}
