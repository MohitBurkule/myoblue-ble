#!/usr/bin/env bash
# Emulator smoke test for the Android app, driven through the UI with the demo sensor:
# calibrate -> record -> markers -> background -> stop -> session analysis -> recordings list.
# Usage: tools/android_smoke.sh path/to/app.apk [outdir]
set -uo pipefail
APK=$1; OUT=${2:-smoke}; PKG=com.mohitburkule.myoblue
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
fail() { echo "FAIL: $*"; adb exec-out screencap -p > "$OUT/failure.png"; adb logcat -d > "$OUT/logcat.txt"; exit 1; }
shot() { adb exec-out screencap -p > "$OUT/$1.png"; echo "screenshot $1"; }
# uiautomator needs a moment of UI idle; never reuse a stale dump
dump() {
  rm -f "$OUT/ui.xml"; adb shell rm -f /sdcard/ui.xml
  for i in 1 2 3 4 5 6; do
    adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 && adb pull /sdcard/ui.xml "$OUT/ui.xml" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "(ui dump failed)"
}
has() { dump; python3 "$HERE/ui_find.py" "$OUT/ui.xml" "$1" >/dev/null; }
tap() {
  for i in 1 2 3 4 5; do
    dump
    if xy=$(python3 "$HERE/ui_find.py" "$OUT/ui.xml" "$1"); then adb shell input tap $xy; echo "tap '$1' at $xy"; return 0; fi
    sleep 2
  done
  fail "button '$1' not found"
}
alive() { adb shell pidof $PKG >/dev/null || fail "app process died"; }

adb install -r -g "$APK" || fail "install"
adb logcat -c
adb shell monkey -p $PKG -c android.intent.category.LAUNCHER 1 >/dev/null
sleep 15
alive; shot 01-start
has "Connect your sensors" || fail "empty state not shown"

tap "Try a demo sensor"; sleep 6; alive; shot 02-live

tap "Calibrate"; sleep 2
tap "Start"; sleep 20; shot 03-calibration
has "Results" || fail "calibration results not shown"
tap "Save"; sleep 2

tap "● Record"; sleep 3; shot 04-new-recording
tap "● Start recording"; sleep 6; alive; shot 05-recording
adb shell dumpsys activity services $PKG | grep -q "RecordingService" || fail "foreground service not running"
echo "foreground service running"
tap "rest"; sleep 2
tap "contract"; sleep 3

# app in the background: the service must keep the process and recording alive
adb shell input keyevent KEYCODE_HOME; sleep 15; alive
adb shell dumpsys activity services $PKG | grep -q "isForeground=true" || fail "service not foreground while app in background"
echo "still recording in background"
adb shell monkey -p $PKG -c android.intent.category.LAUNCHER 1 >/dev/null; sleep 4

tap "Stop"; sleep 8; alive; shot 06-session
has "By marker" || fail "session stats not shown"
tap "Share CSV"; sleep 6; shot 07-share
adb shell input keyevent KEYCODE_BACK; sleep 2

adb shell input keyevent KEYCODE_BACK; sleep 2
tap "Recordings"; sleep 3; shot 08-recordings
tap "Settings"; sleep 2; shot 09-settings
alive

adb logcat -d > "$OUT/logcat.txt"
if grep -A6 "FATAL EXCEPTION" "$OUT/logcat.txt" | grep -q "$PKG"; then grep -A20 "FATAL EXCEPTION" "$OUT/logcat.txt" | head -40; fail "app crashed"; fi
if grep -E "ReactNativeJS.*(Error|TypeError|undefined is not)" "$OUT/logcat.txt" | head -10 | grep .; then fail "JavaScript errors in logcat"; fi
echo "SMOKE TEST PASSED"
