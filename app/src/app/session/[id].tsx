import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { BANDS, type BandId } from "../../core/dsp";
import { columnsInRange, segmentStats } from "../../core/session";
import { StaticPlot, type Columns } from "../../components/plots";
import { Body, Button, Card, Choice, Label, Pill, Title } from "../../components/ui";
import { useRecording } from "../../lib/recorder";
import { deleteSession, exportSession, loadSession, share, updateSessionMeta, type LoadedSession } from "../../lib/sessions";
import { clock, sensorColor, useTheme } from "../../lib/theme";

const WINDOWS = [2, 5, 10, 30, 60] as const;
const COLS = 320;

export default function SessionScreen() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const rec = useRecording();
  const [s, setS] = useState<LoadedSession | null>(null);
  const [band, setBand] = useState<BandId | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [winLen, setWinLen] = useState<number>(5);
  const [winStart, setWinStart] = useState(0); // s
  const [view, setView] = useState<"filtered" | "raw">("filtered");
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const recordingThis = rec.active && rec.id === id;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    // yield a frame so the spinner shows; decoding a long session takes a moment
    const h = setTimeout(async () => {
      try {
        const loaded = await loadSession(id, band ? { band, notch: s?.filters.notch ?? 50 } : undefined);
        if (!alive) return;
        if (!loaded) { setError("This recording couldn't be read."); return; }
        setS(loaded);
        if (!band) { setBand(loaded.filters.band); setName(loaded.meta.name); setNotes(loaded.meta.notes); }
      } catch (e: any) {
        if (alive) setError(e?.message ?? String(e));
      } finally {
        if (alive) setLoading(false);
      }
    }, 30);
    return () => { alive = false; clearTimeout(h); };
  }, [id, band, recordingThis]);

  const durS = s ? s.durationMs / 1000 : 0;
  const win: [number, number] = [Math.max(0, Math.min(winStart, Math.max(0, durS - winLen))), 0];
  win[1] = Math.min(durS, win[0] + winLen);

  const overview = useMemo(() => {
    if (!s || !durS) return [];
    return s.series.map((x) => {
      const c = columnsInRange(x, x.env, 0, durS * 1000, COLS);
      const cal = x.meta.calibration;
      return { series: x, cols: c, ymax: Math.max(c.hi === -Infinity ? 10 : c.hi * 1.1, cal ? cal.mvcRms * 1.1 : 0, 10) };
    });
  }, [s, durS]);

  const zoom = useMemo(() => {
    if (!s || !durS) return [];
    return s.series.map((x) => {
      const c = columnsInRange(x, view === "raw" ? x.uv : x.filt, win[0] * 1000, win[1] * 1000, COLS);
      const e = view === "filtered" ? columnsInRange(x, x.env, win[0] * 1000, win[1] * 1000, COLS) : null;
      let ymin: number, ymax: number;
      if (c.lo === Infinity) { ymin = -50; ymax = 50; }
      else if (view === "raw") { const pad = Math.max((c.hi - c.lo) * 0.1, 5); ymin = c.lo - pad; ymax = c.hi + pad; }
      else { const m = Math.max(Math.abs(c.lo), Math.abs(c.hi), 10) * 1.1; ymin = -m; ymax = m; }
      return { series: x, cols: c as Columns, env: e?.maxs ?? null, ymin, ymax };
    });
  }, [s, durS, win[0], win[1], view]);

  const stats = useMemo(() => (s && durS ? segmentStats(s.series, s.markers, durS) : []), [s, durS]);

  if (loading && !s) return <Center><ActivityIndicator color={t.accent} /><Body muted>Loading recording…</Body></Center>;
  if (error || !s) return <Center><Body style={{ color: t.bad }}>{error ?? "Not found"}</Body></Center>;

  const markersX = s.markers.map((m) => ({ x: durS ? m.t / durS : 0, label: m.label }));
  const markersInWin = s.markers.filter((m) => m.t >= win[0] && m.t <= win[1]).map((m) => ({ x: (m.t - win[0]) / (win[1] - win[0] || 1), label: m.label }));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ x: f, text: clock(f * durS) }));

  async function doExport(kind: "csv" | "json") {
    setBusy(kind === "csv" ? "Writing CSV…" : "Writing JSON…");
    await new Promise((r) => setTimeout(r, 30));
    try {
      const files = exportSession(s!);
      await share(kind === "csv" ? files.csv : files.json, kind === "csv" ? "text/csv" : "application/json");
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  const input = { color: t.ink, backgroundColor: t.panel, borderColor: t.line, borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 15 } as const;

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}>
      <Stack.Screen options={{ title: s.meta.name }} />
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Title style={{ flex: 1 }}>{s.meta.name}</Title>
          {recordingThis ? <Pill text="Recording" tone="bad" /> : !s.complete ? <Pill text="Interrupted" tone="warn" /> : null}
        </View>
        <Text style={{ color: t.muted, fontVariant: ["tabular-nums"] }}>
          {new Date(s.meta.createdAt).toLocaleString()} · {clock(durS)} · {s.series.map((x) => `${x.meta.short} ${x.sampleRate.toFixed(0)} Hz`).join(" · ")}
        </Text>
        {recordingThis ? <Body muted style={{ fontSize: 13 }}>Still recording. This view shows what was captured when you opened it.</Body> : null}
      </View>

      <Choice label="Signal" value={band ?? s.filters.band} onChange={(b) => setBand(b)}
        options={(Object.keys(BANDS) as BandId[]).map((b) => ({ value: b, label: BANDS[b].short }))} />
      {loading ? <ActivityIndicator color={t.accent} /> : null}

      <Label>Whole recording · envelope (tap to zoom)</Label>
      {overview.map((o) => (
        <Card key={o.series.meta.id}>
          <Text style={{ color: t.ink, fontWeight: "700", paddingHorizontal: 12, paddingTop: 8 }}>{o.series.meta.short} · {o.series.meta.name.replace(/_/g, " ")}</Text>
          <StaticPlot columns={o.cols} height={110} color={sensorColor(t, o.series.meta.short)} ymin={0} ymax={o.ymax}
            markers={markersX} window={durS ? [win[0] / durS, win[1] / durS] : null} xLabels={ticks}
            onPress={(f) => setWinStart(Math.max(0, f * durS - winLen / 2))} />
        </Card>
      ))}
      {!s.series.length ? <Body muted>No sensor data in this recording.</Body> : null}

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Label style={{ flex: 1 }}>Zoom · {clock(win[0])}–{clock(win[1])}</Label>
        <Button title="◀" small onPress={() => setWinStart(Math.max(0, win[0] - winLen))} />
        <Button title="▶" small onPress={() => setWinStart(Math.min(Math.max(0, durS - winLen), win[0] + winLen))} />
      </View>
      <Choice value={winLen} onChange={setWinLen} options={WINDOWS.map((w) => ({ value: w, label: `${w} s` }))} />
      <Choice value={view} onChange={setView} options={[{ value: "filtered", label: "Filtered + envelope" }, { value: "raw", label: "Raw" }]} />
      {zoom.map((z) => (
        <Card key={z.series.meta.id}>
          <StaticPlot columns={z.cols} overlay={z.env} height={160} color={sensorColor(t, z.series.meta.short)} ymin={z.ymin} ymax={z.ymax} markers={markersInWin} />
        </Card>
      ))}

      {stats.length ? (
        <>
          <Label>By marker</Label>
          <Card>
            {stats.map((seg, i) => (
              <View key={i} style={{ padding: 12, borderBottomWidth: i < stats.length - 1 ? 1 : 0, borderBottomColor: t.line, gap: 4 }}>
                <Text style={{ color: t.ink, fontWeight: "700" }}>{seg.label} <Text style={{ color: t.muted, fontWeight: "400" }}>· {clock(seg.start)}–{clock(seg.end)} ({(seg.end - seg.start).toFixed(1)} s)</Text></Text>
                {seg.perSensor.map((p) => (
                  <Text key={p.short} style={{ color: t.muted, fontVariant: ["tabular-nums"], fontSize: 13 }}>
                    <Text style={{ color: sensorColor(t, p.short), fontWeight: "700" }}>{p.short}</Text>
                    {p.meanPct !== null
                      ? `  mean ${p.meanPct.toFixed(0)}% MVC · peak ${p.peakPct!.toFixed(0)}% · active ${p.activePct!.toFixed(0)}%`
                      : `  mean ${p.meanEnv.toFixed(1)} µV · peak ${p.peakEnv.toFixed(0)} µV (not calibrated)`}
                  </Text>
                ))}
              </View>
            ))}
          </Card>
        </>
      ) : null}

      <Label>Export</Label>
      <Body muted style={{ fontSize: 13 }}>CSV: one row per millisecond with raw, filtered and envelope µV per sensor (plus % MVC if calibrated) and markers, using the signal preset selected above. JSON: notes, calibration, markers and measured sample rates.</Body>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button title={busy ?? "Share CSV"} variant="primary" style={{ flex: 1.4 }} disabled={!!busy || !s.series.length} onPress={() => doExport("csv")} />
        <Button title="Share JSON" style={{ flex: 1 }} disabled={!!busy} onPress={() => doExport("json")} />
      </View>

      <Label>Details</Label>
      <TextInput value={name} onChangeText={setName} style={input} placeholder="Name" placeholderTextColor={t.muted} />
      <TextInput value={notes} onChangeText={setNotes} multiline style={[input, { minHeight: 70, textAlignVertical: "top" }]} placeholder="Notes" placeholderTextColor={t.muted} />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button title="Save details" style={{ flex: 1 }} disabled={name === s.meta.name && notes === s.meta.notes}
          onPress={() => { updateSessionMeta(s.id, { name: name.trim() || s.meta.name, notes }); setS({ ...s, meta: { ...s.meta, name: name.trim() || s.meta.name, notes } }); }} />
        <Button title={confirmDelete ? "Tap again to delete" : "Delete"} variant="danger" style={{ flex: 1 }} disabled={recordingThis}
          onPress={() => {
            if (!confirmDelete) { setConfirmDelete(true); setTimeout(() => setConfirmDelete(false), 3000); return; }
            deleteSession(s.id);
            router.back();
          }} />
      </View>
    </ScrollView>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: t.bg, padding: 24 }}>{children}</View>;
}
