import React, { useState } from "react";
import { ScrollView, TextInput } from "react-native";
import { router } from "expo-router";
import { Body, Button, Label } from "../components/ui";
import { startRecording } from "../lib/recorder";
import { getSensors } from "../lib/sensors";
import { useTheme } from "../lib/theme";

export default function RecordScreen() {
  const t = useTheme();
  const now = new Date();
  const [name, setName] = useState(`Session ${now.toLocaleDateString()} ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const uncal = getSensors().filter((s) => !s.cal).map((s) => s.short);
  const input = { color: t.ink, backgroundColor: t.panel, borderColor: t.line, borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 16 } as const;
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 10 }} keyboardShouldPersistTaps="handled">
      <Label>Name</Label>
      <TextInput value={name} onChangeText={setName} style={input} placeholderTextColor={t.muted} />
      <Label>Notes</Label>
      <TextInput value={notes} onChangeText={setNotes} multiline style={[input, { minHeight: 90, textAlignVertical: "top" }]}
        placeholder="Muscle, electrode placement, subject, task…" placeholderTextColor={t.muted} />
      <Body muted style={{ fontSize: 13 }}>
        {uncal.length ? `Not calibrated: ${uncal.join(", ")}. You can still record; % MVC is only available for calibrated sensors.` : "All sensors calibrated; calibration is saved with the recording."}
      </Body>
      <Body muted style={{ fontSize: 13 }}>Recording keeps running with the screen off, during calls, or with other apps open. Stop it here or from the notification.</Body>
      {error ? <Body style={{ color: t.bad }}>{error}</Body> : null}
      <Button title="● Start recording" variant="record" onPress={() => {
        if (startRecording(name.trim() || "Recording", notes.trim())) router.back();
        else setError("Couldn't start the recording.");
      }} />
    </ScrollView>
  );
}
