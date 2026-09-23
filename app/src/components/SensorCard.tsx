import React from "react";
import { Pressable, Text, View } from "react-native";
import Native from "../../modules/myoblue-native";
import { removeSensor, type LiveSensor } from "../lib/sensors";
import type { Settings } from "../lib/settings";
import { sensorColor, useTheme } from "../lib/theme";
import { EffortMeter, LivePlot, SpectrumPlot, useTick } from "./plots";
import { Button, Card, Pill, Stat, type Tone } from "./ui";

const STATE: Record<string, [string, Tone]> = {
  connecting: ["Connecting…", "warn"],
  discovering: ["Connecting…", "warn"],
  live: ["Live", "ok"],
  demo: ["Demo", "ok"],
  reconnecting: ["Reconnecting…", "warn"],
  disconnected: ["Disconnected", "bad"],
  failed: ["No permission", "bad"],
};

export function SensorCard({ sensor, settings }: { sensor: LiveSensor; settings: Settings }) {
  const t = useTheme();
  useTick(500); // stats refresh
  const color = sensorColor(t, sensor.short);
  const stalled = (sensor.state === "live" || sensor.state === "demo") && sensor.lastPacketAt > 0 && nowMs(sensor) - sensor.lastPacketAt > 2500;
  const [label, tone] = stalled ? (["No data", "warn"] as [string, Tone]) : STATE[sensor.state] ?? [sensor.state, "neutral"];
  const cal = sensor.cal;
  const holding = settings.scale === "hold" || (settings.scale === "mvc" && !cal);
  const active = cal && sensor.envNow > cal.threshold && !stalled && (sensor.state === "live" || sensor.state === "demo");
  return (
    <Card>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingTop: 10 }}>
        <View style={{ width: 12, height: 12, borderRadius: 4, backgroundColor: color }} />
        <Text style={{ color: t.ink, fontWeight: "700", fontSize: 15, flex: 1 }} numberOfLines={1}>{sensor.name.replace(/_/g, " ")}</Text>
        <Button title="Remove" small onPress={() => removeSensor(sensor.id)} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingTop: 2, paddingBottom: 4 }}>
        <Pill text={label} tone={tone} />
        {active ? <Pill text="Active" color={color} /> : null}
        <Text style={{ color: t.muted, fontSize: 12, flex: 1 }} numberOfLines={1}>{sensor.source === "demo" ? "Simulated signal" : sensor.id}</Text>
        {holding ? <Button title="Reset scale" small onPress={() => { sensor.hold = null; }} /> : null}
        <Button title="Reset stats" small onPress={() => sensor.resetStats()} />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 2, paddingHorizontal: 12, paddingBottom: 6 }}>
        <Stat label="Battery" value={sensor.battery ? `${sensor.battery.toFixed(2)} V` : "–"} tone={sensor.battery !== null && sensor.battery < 2.5 ? "bad" : undefined} />
        <Stat label="Rate" value={sensor.rate ? `${Math.round(sensor.rate)} Hz` : "–"} />
        <Stat label="Lost" value={`${sensor.lossPct.toFixed(sensor.lossPct < 10 ? 1 : 0)}%`} />
        <Stat label="Cal" value={cal ? `MVC ${cal.mvcRms.toFixed(0)} µV` : "none"} />
      </View>
      <Pressable onPress={() => { sensor.hold = null; }} accessibilityLabel="Signal plot. Tap to reset the peak-hold scale.">
        <LivePlot sensor={sensor} settings={settings} color={color} />
      </Pressable>
      {settings.spectrum ? <SpectrumPlot sensor={sensor} source={settings.viewMode === "raw" ? "raw" : "filtered"} color={color} /> : null}
      <EffortMeter sensor={sensor} color={color} />
    </Card>
  );
}

// packet times are on the native elapsedRealtime clock (demo on web: Date.now())
function nowMs(_s: LiveSensor) {
  return Native ? Native.now() : Date.now();
}
