import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type PressableProps, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { useTheme, type Theme } from "../lib/theme";

type Variant = "plain" | "primary" | "record" | "stop" | "danger";

export function Button({ title, variant = "plain", small, style, icon, ...rest }:
  PressableProps & { title: string; variant?: Variant; small?: boolean; style?: StyleProp<ViewStyle>; icon?: React.ReactNode }) {
  const t = useTheme();
  const c = colors(t, variant);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      {...rest}
      style={({ pressed }) => [
        styles.btn, small && styles.btnSmall,
        { backgroundColor: c.bg, borderColor: c.border, opacity: rest.disabled ? 0.45 : pressed ? 0.8 : 1 },
        style,
      ]}
    >
      {icon}
      <Text style={[styles.btnText, small && styles.btnTextSmall, { color: c.fg }]} numberOfLines={1}>{title}</Text>
    </Pressable>
  );
}

function colors(t: Theme, v: Variant) {
  switch (v) {
    case "primary": return { bg: t.accent, border: t.accent, fg: t.accentInk };
    case "record": return { bg: t.dark ? "#2a1715" : "#fdf0ef", border: t.rec, fg: t.rec };
    case "stop": return { bg: t.rec, border: t.rec, fg: "#fff" };
    case "danger": return { bg: t.panel, border: t.line, fg: t.bad };
    default: return { bg: t.panel, border: t.line, fg: t.ink };
  }
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[styles.card, { backgroundColor: t.panel, borderColor: t.line }, style]}>{children}</View>;
}

export type Tone = "neutral" | "ok" | "warn" | "bad" | "accent";
export function Pill({ text, tone = "neutral", color }: { text: string; tone?: Tone; color?: string }) {
  const t = useTheme();
  const fg = color ?? { neutral: t.muted, ok: t.ok, warn: t.warn, bad: t.bad, accent: t.accent }[tone];
  return (
    <View style={[styles.pill, { backgroundColor: fg + "22" }]}>
      <Text style={[styles.pillText, { color: fg }]} numberOfLines={1}>{text}</Text>
    </View>
  );
}

export function Label({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return <Text style={[styles.label, { color: t.muted }, style]}>{children}</Text>;
}

export function Body({ children, style, muted, numberOfLines }: { children: React.ReactNode; style?: StyleProp<TextStyle>; muted?: boolean; numberOfLines?: number }) {
  const t = useTheme();
  return <Text numberOfLines={numberOfLines} style={[styles.body, { color: muted ? t.muted : t.ink }, style]}>{children}</Text>;
}

export function Title({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return <Text style={[styles.title, { color: t.ink }, style]}>{children}</Text>;
}

/** Horizontal choice chips (a compact replacement for a select box). */
export function Choice<T extends string | number>({ label, value, options, onChange }:
  { label?: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const t = useTheme();
  return (
    <View style={{ gap: 6 }}>
      {label ? <Label>{label}</Label> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <Pressable
              key={String(o.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => onChange(o.value)}
              style={[styles.choice, { borderColor: on ? t.accent : t.line, backgroundColor: on ? t.accent + "1f" : t.panel }]}
            >
              <Text style={[styles.choiceText, { color: on ? t.accent : t.ink }]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

export function Toggle({ label, value, onChange, hint }: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="switch" accessibilityState={{ checked: value }} onPress={() => onChange(!value)} style={styles.toggleRow}>
      <View style={{ flex: 1 }}>
        <Body>{label}</Body>
        {hint ? <Body muted style={{ fontSize: 13 }}>{hint}</Body> : null}
      </View>
      <View style={[styles.track, { backgroundColor: value ? t.accent : t.line }]}>
        <View style={[styles.knob, { alignSelf: value ? "flex-end" : "flex-start" }]} />
      </View>
    </Pressable>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string; tone?: "bad" }) {
  const t = useTheme();
  return (
    <Text style={[styles.stat, { color: t.muted }]}>
      {label} <Text style={{ color: tone === "bad" ? t.bad : t.ink, fontWeight: "600" }}>{value}</Text>
    </Text>
  );
}

export const styles = StyleSheet.create({
  btn: { minHeight: 46, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  btnSmall: { minHeight: 36, paddingHorizontal: 12, borderRadius: 10 },
  btnText: { fontSize: 15, fontWeight: "600" },
  btnTextSmall: { fontSize: 13 },
  card: { borderWidth: 1, borderRadius: 16, overflow: "hidden" },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  pillText: { fontSize: 12, fontWeight: "600" },
  label: { fontSize: 13, fontWeight: "500" },
  body: { fontSize: 15, lineHeight: 21 },
  title: { fontSize: 20, fontWeight: "700", letterSpacing: -0.2 },
  choice: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, minHeight: 36, justifyContent: "center" },
  choiceText: { fontSize: 14, fontWeight: "600" },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48 },
  track: { width: 46, height: 28, borderRadius: 14, padding: 3 },
  knob: { width: 22, height: 22, borderRadius: 11, backgroundColor: "#fff" },
  stat: { fontSize: 12.5, fontVariant: ["tabular-nums"] },
});
