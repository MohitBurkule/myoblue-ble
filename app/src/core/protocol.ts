/**
 * ELEMYO MYOblue v1.2 packet format (datasheet + HCI traces).
 *
 * Nordic UART Service notifications, 244 bytes each:
 *   module u8 | sequence u24 LE | battery u16 LE | 119 samples u16 LE (14-bit, 8192 = 0 V)
 * The sensor clock runs ~2-3% slow, so the real rate is ≈975 samples/s, not 1000.
 * Once a minute the sensor measures its battery instead of EMG; that packet's samples are all 8192.
 */

export const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
export const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
export const NOMINAL_FS = 1000;
export const PER_PACKET = 119;
export const PACKET_BYTES = 6 + PER_PACKET * 2;
export const UV_PER_LSB = (2.5 / 16384) * 2000; // same scale as MYOblue_GUI
export const BATTERY_V_PER_LSB = (0.6 * 6 * 2) / 16384; // same as MYOblue_GUI
/** One stored row: float64 LE ms since recording start + the raw packet. */
export const ROW_BYTES = 8 + PACKET_BYTES;
export const SENSOR_NAME_RE = /^\d+_MYOblue/;

export interface Packet {
  module: number;
  seq: number;
  battery: number;
  /** true for the once-a-minute battery-measurement packet (no EMG in it) */
  empty: boolean;
  /** microvolts */
  uv: Float32Array;
}

export function parsePacket(bytes: Uint8Array, out?: Float32Array): Packet | null {
  if (bytes.length < PACKET_BYTES) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const uv = out ?? new Float32Array(PER_PACKET);
  let empty = true;
  for (let i = 0; i < PER_PACKET; i++) {
    const raw = dv.getUint16(6 + i * 2, true);
    if (raw !== 8192) empty = false;
    uv[i] = (raw - 8192) * UV_PER_LSB;
  }
  return {
    module: bytes[0],
    seq: bytes[1] | (bytes[2] << 8) | (bytes[3] << 16),
    battery: dv.getUint16(4, true) * BATTERY_V_PER_LSB,
    empty,
    uv,
  };
}

/** Packets lost between two sequence numbers (24-bit counter). */
export function seqGap(prev: number, seq: number): number {
  return (seq - prev - 1) & 0xffffff;
}

/** Short column name from the advertised name: "2_MYOblue_v1.2_7F3A3" -> "S2". */
export function shortName(name: string, fallback = 1): string {
  const n = parseInt(name, 10);
  return "S" + (Number.isFinite(n) && n > 0 ? n : fallback);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function base64ToBytes(s: string): Uint8Array {
  let len = s.length;
  while (len > 0 && s[len - 1] === "=") len--;
  const out = new Uint8Array((len * 3) >> 2);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const a = B64_LOOKUP[s.charCodeAt(i)], b = B64_LOOKUP[s.charCodeAt(i + 1)];
    const c = B64_LOOKUP[s.charCodeAt(i + 2)], d = B64_LOOKUP[s.charCodeAt(i + 3)];
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    s += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    s += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return s;
}
