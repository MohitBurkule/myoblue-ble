import React, { useCallback, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Body, Card, Pill, Title } from "../../components/ui";
import { useRecording } from "../../lib/recorder";
import { listSessions, type SessionSummary } from "../../lib/sessions";
import { clock, useTheme } from "../../lib/theme";

export default function RecordingsScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const rec = useRecording();
  const [items, setItems] = useState<SessionSummary[]>([]);
  useFocusEffect(useCallback(() => {
    setItems(listSessions());
    const id = setInterval(() => setItems(listSessions()), 3000); // growing sizes while recording
    return () => clearInterval(id);
  }, [rec.active]));

  return (
    <FlatList
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, gap: 10 }}
      data={items}
      keyExtractor={(s) => s.id}
      ListHeaderComponent={<Title style={{ marginBottom: 4 }}>Recordings</Title>}
      ListEmptyComponent={<Body muted>No recordings yet. Connect a sensor on the Live tab and tap Record.</Body>}
      renderItem={({ item: s }) => {
        const recording = rec.active && rec.id === s.id;
        const mb = s.bytes / 1e6;
        return (
          <Pressable onPress={() => router.push({ pathname: "/session/[id]", params: { id: s.id } })}>
            <Card style={{ padding: 14, gap: 4 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ color: t.ink, fontWeight: "700", fontSize: 16, flex: 1 }} numberOfLines={1}>{s.meta.name}</Text>
                {recording ? <Pill text="Recording" tone="bad" /> : !s.complete ? <Pill text="Interrupted" tone="warn" /> : null}
              </View>
              <Text style={{ color: t.muted, fontSize: 13, fontVariant: ["tabular-nums"] }}>
                {new Date(s.meta.createdAt).toLocaleString()} · {clock(s.durationMs / 1000)} · {s.sensorCount} sensor{s.sensorCount === 1 ? "" : "s"} · {s.markerCount} marker{s.markerCount === 1 ? "" : "s"} · {mb < 1 ? `${Math.max(1, Math.round(s.bytes / 1e3))} KB` : `${mb.toFixed(1)} MB`}
              </Text>
              {s.meta.notes ? <Text style={{ color: t.muted, fontSize: 13 }} numberOfLines={2}>{s.meta.notes}</Text> : null}
            </Card>
          </Pressable>
        );
      }}
    />
  );
}
