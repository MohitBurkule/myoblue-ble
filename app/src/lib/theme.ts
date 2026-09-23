import { useColorScheme } from "react-native";

export interface Theme {
  dark: boolean;
  bg: string;
  panel: string;
  panel2: string;
  ink: string;
  muted: string;
  line: string;
  grid: string;
  accent: string;
  accentInk: string;
  rec: string;
  ok: string;
  warn: string;
  bad: string;
  sensors: string[];
}

const light: Theme = {
  dark: false,
  bg: "#f6f7f9", panel: "#ffffff", panel2: "#f0f2f5", ink: "#15171c", muted: "#5f6878",
  line: "#e2e5ea", grid: "#eceef2", accent: "#2458d6", accentInk: "#ffffff", rec: "#d92d20",
  ok: "#15803d", warn: "#b45309", bad: "#c2261a",
  sensors: ["#2458d6", "#c3317a", "#0f8a66", "#b8680b", "#7042d1", "#0a7f99", "#5b8a12", "#d1334f"],
};

const dark: Theme = {
  dark: true,
  bg: "#0e1014", panel: "#171a20", panel2: "#1f232b", ink: "#e9ebef", muted: "#9aa3b2",
  line: "#2a2f39", grid: "#22262e", accent: "#6d9bff", accentInk: "#0b1020", rec: "#ff5a4e",
  ok: "#4ade80", warn: "#fbbf24", bad: "#ff6b5e",
  sensors: ["#6d9bff", "#f17cb4", "#3ed3a0", "#f5b14c", "#b392ff", "#3fc9e6", "#a4d65a", "#ff7b8f"],
};

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

export function sensorColor(t: Theme, short: string): string {
  const n = parseInt(short.slice(1), 10) || 1;
  return t.sensors[(n - 1) % t.sensors.length];
}

export function clock(sec: number): string {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

export function uvLabel(v: number): string {
  return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)} mV` : `${Math.round(v)} µV`;
}
