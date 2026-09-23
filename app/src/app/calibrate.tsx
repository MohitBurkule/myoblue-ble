import React, { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { useKeepAwake } from "expo-keep-awake";
import { summarize, verdict, VERDICT_LABEL, type Calibration } from "../core/calibration";
import { Body, Button, Card, Title } from "../components/ui";
import { getSensors, setDemoHint, type LiveSensor } from "../lib/sensors";
import { getSettings, updateSettings } from "../lib/settings";
import { sensorColor, useTheme } from "../lib/theme";

type Phase = { kind: "intro" } | { kind: "run"; title: string; text: string; prep: number; left: number } | { kind: "results"; results: [LiveSensor, Calibration | null][] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function CalibrateScreen() {
  const t = useTheme();
  useKeepAwake();
  const live = getSensors().filter((s) => s.state === "live" || s.state === "demo");
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(live.map((s) => s.id)));
  const [phase, setPhase] = useState<Phase>({ kind: "intro" });
  const running = useRef(false);

  useEffect(() => () => { running.current = false; setDemoHint(null); for (const s of getSensors()) s.capture = null; }, []);

  async function step(title: string, text: string, hint: "rest" | "mvc"): Promise<Map<string, number[]> | null> {
    for (let i = 3; i > 0; i--) {
      if (!running.current) return null;
      setPhase({ kind: "run", title, text, prep: i, left: 5 });
      await sleep(1000);
    }
    const sensors = getSensors().filter((s) => chosen.has(s.id));
    const caps = new Map(sensors.map((s) => [s.id, (s.capture = [])]));
    setDemoHint(hint);
    const t0 = Date.now();
    while (running.current && Date.now() - t0 < 5000) {
      setPhase({ kind: "run", title, text, prep: 0, left: 5 - (Date.now() - t0) / 1000 });
      await sleep(100);
    }
    setDemoHint(null);
    for (const s of sensors) s.capture = null;
    return running.current ? caps : null;
  }

  async function run() {
    running.current = true;
    const rest = await step("Step 1 of 2 · Rest", "Relax the muscle completely", "rest");
    if (!rest) return;
    const mvc = await step("Step 2 of 2 · Maximum contraction", "Contract as hard as you can and hold", "mvc");
    if (!mvc) return;
    running.current = false;
    const s = getSettings();
    const results = getSensors().filter((x) => chosen.has(x.id))
      .map((x) => [x, summarize(rest.get(x.id) ?? [], mvc.get(x.id) ?? [], { band: s.band, notch: s.notch })] as [LiveSensor, Calibration | null]);
    setPhase({ kind: "results", results });
  }

  function save(results: [LiveSensor, Calibration | null][]) {
    const calibrations = { ...getSettings().calibrations };
    for (const [s, c] of results) if (c) calibrations[s.name] = c;
    updateSettings({ calibrations });
    router.back();
  }

  const pad = { padding: 16, gap: 14 };
  if (phase.kind === "intro") {
    return (
      <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={pad}>
        <Body>Calibration measures each sensor's resting noise and your maximum voluntary contraction (MVC). The app then shows effort as % of maximum, marks when the muscle is active, and saves both with every recording.</Body>
        <Body muted style={{ fontSize: 13 }}>Place the sensors where you will record. Two steps of 5 seconds: relax completely, then contract as hard as you can.</Body>
        <Card style={{ padding: 6 }}>
          {live.map((s) => {
            const on = chosen.has(s.id);
            return (
              <Pressable key={s.id} style={{ flexDirection: "row", alignItems: "center", gap: 10, padding: 10 }} onPress={() => {
                const n = new Set(chosen); on ? n.delete(s.id) : n.add(s.id); setChosen(n);
              }}>
                <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: on ? t.accent : t.line, backgroundColor: on ? t.accent : "transparent" }} />
                <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: sensorColor(t, s.short) }} />
                <Text style={{ color: t.ink, fontSize: 15, flex: 1 }}>{s.name.replace(/_/g, " ")}{s.cal ? "  (recalibrate)" : ""}</Text>
              </Pressable>
            );
          })}
          {!live.length ? <Body muted style={{ padding: 10 }}>No sensor is streaming right now.</Body> : null}
        </Card>
        <Button title="Start" variant="primary" disabled={!chosen.size} onPress={run} />
      </ScrollView>
    );
  }
  if (phase.kind === "run") {
    const progress = phase.prep ? 0 : 1 - phase.left / 5;
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, padding: 24, justifyContent: "center", gap: 24 }}>
        <Body muted style={{ textAlign: "center" }}>{phase.title}</Body>
        <Title style={{ textAlign: "center", fontSize: 26 }}>{phase.text}</Title>
        <View style={{ height: 12, borderRadius: 999, backgroundColor: t.panel2, overflow: "hidden" }}>
          <View style={{ width: `${progress * 100}%`, height: "100%", backgroundColor: t.accent }} />
        </View>
        <Text style={{ color: t.ink, fontSize: 56, fontWeight: "800", textAlign: "center", fontVariant: ["tabular-nums"] }}>
          {phase.prep ? `Get ready… ${phase.prep}` : Math.ceil(phase.left)}
        </Text>
        <Button title="Cancel" onPress={() => { running.current = false; router.back(); }} />
      </View>
    );
  }
  const ok = phase.results.filter(([, c]) => c);
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={pad}>
      <Title>Results</Title>
      <Card>
        {phase.results.map(([s, c]) => {
          const v = c ? verdict(c) : null;
          return (
            <View key={s.id} style={{ padding: 12, borderBottomWidth: 1, borderBottomColor: t.line, gap: 4 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: sensorColor(t, s.short) }} />
                <Text style={{ color: t.ink, fontWeight: "700", flex: 1 }}>{s.short}</Text>
                {v ? <Text style={{ color: v === "good" ? t.ok : v === "ok" ? t.warn : t.bad, fontWeight: "700" }}>{VERDICT_LABEL[v]}</Text> : null}
              </View>
              {c ? (
                <Text style={{ color: t.muted, fontVariant: ["tabular-nums"] }}>
                  Rest {c.restRms.toFixed(1)} µV · MVC {c.mvcRms.toFixed(0)} µV · Signal/noise {c.snrDb.toFixed(0)} dB
                </Text>
              ) : <Text style={{ color: t.bad }}>No data received</Text>}
            </View>
          );
        })}
      </Card>
      <Body muted style={{ fontSize: 13 }}>Signal / noise below 10 dB usually means poor skin contact or a sensor off the muscle belly. Rest is the RMS envelope while relaxed; MVC is the 95th percentile of the envelope during the contraction.</Body>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button title="Discard" style={{ flex: 1 }} onPress={() => router.back()} />
        <Button title="Redo" style={{ flex: 1 }} onPress={run} />
        <Button title="Save" variant="primary" style={{ flex: 1 }} disabled={!ok.length} onPress={() => save(phase.results)} />
      </View>
    </ScrollView>
  );
}
