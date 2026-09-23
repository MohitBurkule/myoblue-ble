import React, { useCallback, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Native from "../../../modules/myoblue-native";
import { BANDS, type BandId } from "../../core/dsp";
import { Body, Button, Card, Choice, Label, Title, Toggle } from "../../components/ui";
import { APP_VERSION } from "../../lib/recorder";
import { rebuildFilters, removeSensor, resetHolds } from "../../lib/sensors";
import { updateSettings, useSettings, type Settings } from "../../lib/settings";
import { useTheme } from "../../lib/theme";

export default function SettingsScreen() {
  const t = useTheme();
  const s = useSettings();
  const insets = useSafeAreaInsets();
  const [labels, setLabels] = useState(s.markerLabels);
  const [batteryOk, setBatteryOk] = useState(true);
  useFocusEffect(useCallback(() => { setBatteryOk(Native?.ignoringBatteryOptimizations() ?? true); }, []));
  const set = (patch: Partial<Settings>) => {
    updateSettings(patch);
    if ("band" in patch || "notch" in patch) rebuildFilters();
    if ("scale" in patch || "viewMode" in patch) resetHolds();
  };
  const section = { padding: 14, gap: 14 };
  const cals = Object.entries(s.calibrations);

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, gap: 12, paddingBottom: 40 }}>
      <Title>Settings</Title>

      <Label>Display</Label>
      <Card style={section}>
        <Choice label="View" value={s.viewMode} onChange={(v) => set({ viewMode: v })}
          options={[{ value: "filtered", label: "Filtered" }, { value: "raw", label: "Raw" }, { value: "envelope", label: "Envelope (RMS)" }]} />
        <Choice label="Signal" value={s.band} onChange={(v: BandId) => set({ band: v })}
          options={(Object.keys(BANDS) as BandId[]).map((b) => ({ value: b, label: BANDS[b].label }))} />
        <Choice label="Mains notch" value={s.notch} onChange={(v) => set({ notch: v })}
          options={[{ value: 0, label: "Off" }, { value: 50, label: "50 Hz" }, { value: 60, label: "60 Hz" }]} />
        <Choice label="Time window" value={s.win} onChange={(v) => set({ win: v })}
          options={[{ value: 2, label: "2 s" }, { value: 5, label: "5 s" }, { value: 10, label: "10 s" }]} />
        <Choice label="Y axis" value={s.scale} onChange={(v) => set({ scale: v })}
          options={[
            { value: "auto", label: "Auto" }, { value: "hold", label: "Peak hold" }, { value: "mvc", label: "Fit to MVC" },
            { value: "100", label: "±100 µV" }, { value: "250", label: "±250 µV" }, { value: "500", label: "±500 µV" },
            { value: "1000", label: "±1 mV" }, { value: "2500", label: "±2.5 mV" },
          ]} />
        <Body muted style={{ fontSize: 13 }}>Peak hold only ever grows, so the whole effort stays in view; tap a plot to reset it.</Body>
        <Toggle label="Envelope over signal" value={s.overlay} onChange={(v) => set({ overlay: v })} />
        <Toggle label="Spectrum (FFT)" value={s.spectrum} onChange={(v) => set({ spectrum: v })} />
      </Card>

      <Label>Markers</Label>
      <Card style={section}>
        <Body muted style={{ fontSize: 13 }}>Quick marker buttons shown while recording, separated by commas. The notification's Mark button adds "mark".</Body>
        <TextInput value={labels} onChangeText={setLabels} onEndEditing={() => set({ markerLabels: labels })}
          style={{ color: t.ink, backgroundColor: t.panel2, borderRadius: 10, padding: 10, fontSize: 15 }} />
      </Card>

      <Label>Background recording</Label>
      <Card style={section}>
        <Body>Recordings run in a foreground service (the ongoing notification), so they continue with the screen off, during calls and with other apps open.</Body>
        {batteryOk ? (
          <Body muted style={{ fontSize: 13 }}>Battery optimisation is off for MYOblue, so Android won't stop it.</Body>
        ) : (
          <>
            <Body muted style={{ fontSize: 13 }}>Some phones (Xiaomi, Huawei, Samsung…) still stop apps under battery optimisation. Exclude MYOblue to be safe.</Body>
            <Button title="Turn off battery optimisation" onPress={() => Native?.openBatterySettings()} />
          </>
        )}
      </Card>

      <Label>Sensors</Label>
      <Card style={section}>
        {s.knownSensors.length ? s.knownSensors.map((k) => (
          <View key={k.id} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.ink, fontWeight: "600" }}>{k.name.replace(/_/g, " ")}</Text>
              <Text style={{ color: t.muted, fontSize: 12 }}>{k.id} · reconnects automatically</Text>
            </View>
            <Button title="Forget" small onPress={() => removeSensor(k.id)} />
          </View>
        )) : <Body muted>No saved sensors.</Body>}
        {cals.length ? <Label>Calibrations</Label> : null}
        {cals.map(([name, c]) => (
          <View key={name} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.ink, fontWeight: "600" }}>{name.replace(/_/g, " ")}</Text>
              <Text style={{ color: t.muted, fontSize: 12 }}>MVC {c.mvcRms.toFixed(0)} µV · {c.snrDb.toFixed(0)} dB · {new Date(c.date).toLocaleDateString()}</Text>
            </View>
            <Button title="Clear" small onPress={() => { const n = { ...s.calibrations }; delete n[name]; set({ calibrations: n }); }} />
          </View>
        ))}
      </Card>

      <Body muted style={{ fontSize: 12, textAlign: "center" }}>MYOblue app {APP_VERSION} · works with ELEMYO MYOblue v1.2 sensors without the USB dongle</Body>
    </ScrollView>
  );
}
