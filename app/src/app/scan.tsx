import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import Native from "../../modules/myoblue-native";
import { Body, Button, Card, Label } from "../components/ui";
import { addDemoSensor, connectSensor, ensurePermissions, getSensors, startScan, stopScan, useFound } from "../lib/sensors";
import { useTheme } from "../lib/theme";

export default function ScanScreen() {
  const t = useTheme();
  const found = useFound();
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!Native) { setProblem("Bluetooth isn't available in this build."); return; }
      if (!(await ensurePermissions())) { setProblem("Allow Nearby devices (Bluetooth) for MYOblue in Android settings, then try again."); return; }
      if (!Native.isBluetoothOn()) { setProblem("Bluetooth is off. Turn it on and come back."); return; }
      if (active && !startScan()) setProblem("Couldn't start scanning.");
    })();
    return () => { active = false; stopScan(); };
  }, []);

  const connected = new Set(getSensors().map((s) => s.id));
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Body muted>Switch the sensor on (its light blinks) and keep it close. Sensors stop advertising after a few minutes without a connection; switch them off and on if one doesn't appear.</Body>
      {problem ? <Card style={{ padding: 14 }}><Body style={{ color: t.bad }}>{problem}</Body></Card> : null}
      <Label>{found.length ? "Sensors nearby" : problem ? "" : "Searching…"}</Label>
      {found.map((f) => {
        const already = connected.has(f.id);
        return (
          <Pressable key={f.id} disabled={already} onPress={() => { connectSensor(f.id, f.name); router.back(); }}>
            <Card style={{ padding: 14, flexDirection: "row", alignItems: "center", gap: 12, opacity: already ? 0.5 : 1 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.ink, fontWeight: "700", fontSize: 16 }}>{f.name.replace(/_/g, " ")}</Text>
                <Text style={{ color: t.muted, fontSize: 12 }}>{f.id}</Text>
              </View>
              <Text style={{ color: t.muted, fontVariant: ["tabular-nums"] }}>{already ? "added" : `${f.rssi} dBm`}</Text>
            </Card>
          </Pressable>
        );
      })}
      <View style={{ height: 8 }} />
      <Button title="Add a demo sensor instead" onPress={() => { addDemoSensor(); router.back(); }} />
    </ScrollView>
  );
}
