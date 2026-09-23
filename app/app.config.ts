import type { ConfigContext, ExpoConfig } from "expo/config";

// CI sets VERSION_CODE (the run number) so each build installs over the previous one.
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  android: {
    ...config.android,
    versionCode: Number(process.env.VERSION_CODE ?? config.android?.versionCode ?? 1),
  },
});
