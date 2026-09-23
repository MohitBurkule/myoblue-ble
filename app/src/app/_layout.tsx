import React, { useEffect } from "react";
import { Stack } from "expo-router/stack";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { initRecorder } from "../lib/recorder";
import { ensurePermissions, initSensors, nativeAvailable } from "../lib/sensors";
import { useTheme } from "../lib/theme";

export default function RootLayout() {
  const t = useTheme();
  useEffect(() => {
    initRecorder();
    (async () => {
      if (nativeAvailable) await ensurePermissions();
      initSensors();
    })();
  }, []);
  const header = { headerStyle: { backgroundColor: t.panel }, headerTintColor: t.ink, headerShadowVisible: false, contentStyle: { backgroundColor: t.bg } };
  return (
    <SafeAreaProvider>
      <StatusBar style={t.dark ? "light" : "dark"} />
      <Stack screenOptions={header}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="scan" options={{ title: "Add sensor", presentation: "modal" }} />
        <Stack.Screen name="record" options={{ title: "New recording", presentation: "modal" }} />
        <Stack.Screen name="calibrate" options={{ title: "Calibrate", presentation: "modal", gestureEnabled: false }} />
        <Stack.Screen name="session/[id]" options={{ title: "Recording" }} />
      </Stack>
    </SafeAreaProvider>
  );
}
