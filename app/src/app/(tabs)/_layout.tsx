import React from "react";
import { Tabs } from "expo-router/js-tabs";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { useTheme } from "../../lib/theme";

const icons = {
  index: (c: string) => <Path d="M2 13h4l2.5-7 4 13 3.5-10 2 4h4" stroke={c} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />,
  recordings: (c: string) => <><Rect x={3} y={4} width={18} height={16} rx={3} stroke={c} strokeWidth={2} fill="none" /><Path d="M7 9h10M7 13h10M7 17h6" stroke={c} strokeWidth={2} strokeLinecap="round" /></>,
  settings: (c: string) => <><Path d="M4 7h10M18 7h2M4 17h4M12 17h8" stroke={c} strokeWidth={2} strokeLinecap="round" /><Circle cx={16} cy={7} r={2.2} stroke={c} strokeWidth={2} fill="none" /><Circle cx={10} cy={17} r={2.2} stroke={c} strokeWidth={2} fill="none" /></>,
};

export default function TabsLayout() {
  const t = useTheme();
  const icon = (name: keyof typeof icons) => ({ color }: { color: unknown }) => <Svg width={24} height={24} viewBox="0 0 24 24">{icons[name](String(color))}</Svg>;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.accent,
        tabBarInactiveTintColor: t.muted,
        tabBarStyle: { backgroundColor: t.panel, borderTopColor: t.line },
        sceneStyle: { backgroundColor: t.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Live", tabBarIcon: icon("index") }} />
      <Tabs.Screen name="recordings" options={{ title: "Recordings", tabBarIcon: icon("recordings") }} />
      <Tabs.Screen name="settings" options={{ title: "Settings", tabBarIcon: icon("settings") }} />
    </Tabs>
  );
}
