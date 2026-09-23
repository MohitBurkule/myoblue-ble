import React from "react";
import { ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SensorCard } from "../../components/SensorCard";
import { useTick } from "../../components/plots";
import { Body, Button, Card, Title } from "../../components/ui";
import { addMarker, stopRecording, useRecording } from "../../lib/recorder";
import { addDemoSensor, nativeAvailable, useSensors } from "../../lib/sensors";
import { markerLabels, useSettings } from "../../lib/settings";
import { clock, useTheme } from "../../lib/theme";

export default function LiveScreen() {
  const t = useTheme();
  const sensors = useSensors();
  const settings = useSettings();
  const rec = useRecording();
  const insets = useSafeAreaInsets();
  const anyLive = sensors.some((s) => s.state === "live" || s.state === "demo");

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, gap: 12, paddingBottom: 110 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Title style={{ flex: 1 }}>MYOblue</Title>
          {rec.active ? <RecBadge startedAt={rec.startedAt} /> : null}
        </View>
        {!nativeAvailable ? (
          <Card style={{ padding: 14 }}>
            <Body muted>Bluetooth needs the installed Android app. This build can only show the demo sensor.</Body>
          </Card>
        ) : null}
        {sensors.length === 0 ? (
          <Card style={{ padding: 18, gap: 12 }}>
            <Title style={{ fontSize: 18 }}>Connect your sensors</Title>
            <Body>1. Unplug the USB dongle if it's connected to a computer nearby. It grabs the sensors first.</Body>
            <Body>2. Switch a sensor on. Its light blinks while it waits.</Body>
            <Body>3. Tap <Text style={{ fontWeight: "700" }}>Add sensor</Text> and pick it. Repeat for each sensor.</Body>
            <Body muted style={{ fontSize: 13 }}>Sensors you add are reconnected automatically next time.</Body>
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              <Button title="Add sensor" variant="primary" onPress={() => router.push("/scan")} disabled={!nativeAvailable} />
              <Button title="Try a demo sensor" onPress={addDemoSensor} />
            </View>
          </Card>
        ) : (
          sensors.map((s) => <SensorCard key={s.id} sensor={s} settings={settings} />)
        )}
      </ScrollView>

      <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10, backgroundColor: t.bg, borderTopWidth: 1, borderTopColor: t.line }}>
        {rec.active ? (
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }} style={{ flex: 1 }}>
              <Button title="＋ Mark" small onPress={() => addMarker("mark")} />
              {markerLabels(settings).map((l) => <Button key={l} title={l} small onPress={() => addMarker(l)} />)}
            </ScrollView>
            <Button title="Stop" variant="stop" onPress={() => { const id = stopRecording(); if (id) router.push({ pathname: "/session/[id]", params: { id } }); }} />
          </View>
        ) : (
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button title="Add sensor" style={{ flex: 1 }} onPress={() => router.push("/scan")} />
            <Button title="Calibrate" style={{ flex: 1 }} disabled={!anyLive} onPress={() => router.push("/calibrate")} />
            <Button title="● Record" variant="record" style={{ flex: 1.2 }} disabled={!sensors.length || !nativeAvailable} onPress={() => router.push("/record")} />
          </View>
        )}
      </View>
    </View>
  );
}

function RecBadge({ startedAt }: { startedAt: number }) {
  const t = useTheme();
  useTick(500);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: t.rec + "22" }}>
      <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: t.rec }} />
      <Text style={{ color: t.rec, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{clock((Date.now() - startedAt) / 1000)}</Text>
    </View>
  );
}
