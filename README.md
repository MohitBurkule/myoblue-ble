# myoblue-ble

Use ELEMYO **MYOblue v1.2** EMG sensors without the USB dongle.

The sensors are ordinary Bluetooth LE devices. The dongle is just a relay that forwards their packets to a serial port. This repo has:

| Path | What it is |
| --- | --- |
| [`app/`](app/) | **Android app** (Expo / React Native + a small Kotlin module): records in the background (screen off, calls, other apps), live view, calibration, per-marker analysis, CSV/JSON export. APK on the [Releases page](https://github.com/MohitBurkule/myoblue-ble/releases/latest) |
| [`web/`](web/) | **MYOblue Recorder**, a web app for phones and computers: live view, calibration, recording, CSV export. Live at **https://mohitburkule.github.io/myoblue-ble/** |
| [`bridge/`](bridge/) | Software dongle for a computer: connects to the sensors over Bluetooth and serves the dongle's byte stream on a virtual serial port, so ELEMYO's `MYOblue_GUI.py` works unmodified |
| [`tools/`](tools/) | `fake_sensor.py` (pretend to be a sensor, e.g. to inspect the real dongle) and `web_selftest.mjs` (end-to-end test of the web app in headless Chrome) |

A fork of ELEMYO's GUI with built-in Bluetooth support (no bridge needed) is at [MohitBurkule/MYOblue-GUI](https://github.com/MohitBurkule/MYOblue-GUI).

## Android app

**Install:** open the [latest release](https://github.com/MohitBurkule/myoblue-ble/releases/latest) on the phone, download `myoblue-N.apk` and open it. Android asks once to allow installs from your browser or file manager. Later builds install over the previous one and keep your recordings.

**Why an app:** a web page stops when the phone locks or a call comes in. The app records in an Android *foreground service* (the ongoing notification with **Mark** and **Stop**). The Bluetooth connections and the file writing are native Kotlin inside that service, so recording doesn't depend on the UI at all. Settings → Background recording can exclude the app from battery optimisation for phones that are aggressive about it.

**What it does:**
- **Live:** filtered, raw or envelope view; the same signal presets as the web app (EMG, Wide as in MYOblue GUI, ECG); optional spectrum; auto, peak-hold, calibrated or fixed Y axis; effort meter.
- **Calibration:** 5 s rest + 5 s maximum contraction. Gives % MVC, an activity threshold and a signal-to-noise verdict per sensor.
- **Recording:** name, notes and marker buttons (from the app or the notification). Sensors reconnect automatically if they drop out.
- **Analysis:** an overview of each whole recording with markers, a zoomable detail view, a filter preset you can change after recording, and stats per marker segment (mean and peak % MVC, time active).
- **Export:** the same CSV and JSON as the web app, via the Android share sheet.

**On disk** (`recordings/<id>/` in the app's files): `session.json` (name, notes, calibration), one append-only `<sensor>.bin` per sensor (per packet: float64 ms since start + the raw 244 bytes), `markers.jsonl`, `sensors.json`, and `status.json` (written on stop; if it's missing, the recording was interrupted and everything up to that point is still readable).

**Build:** GitHub Actions ([`.github/workflows/android.yml`](.github/workflows/android.yml)) runs the typecheck and unit tests, then `expo prebuild`, a Gradle release build, and signing with the key stored in repo secrets; it publishes a release. Nothing needs installing locally. Locally: `cd app && npm ci --legacy-peer-deps && npm test && npx tsc --noEmit`.

## Web app

Open the link in **Chrome on Android** (or Chrome/Edge on a computer; Bluefy on iPhone). Unplug the USB dongle first, since it connects to the sensors before anything else can.

1. **Add sensor**: pick `1_MYOblue_…` from the list, then repeat for each sensor.
2. **Calibrate**: 5 s relaxed, then 5 s maximum contraction. The app stores resting noise, the MVC level and an activity threshold per sensor, shows live effort as % MVC, and flags *Active* when the muscle is on.
3. **Record**: name the session, add notes, and tap marker chips (configurable in settings) to tag events. Data is saved in the browser every second, so a closed tab or crash keeps what was captured.
4. **Download** gives two files:
   - `…csv`: one row per millisecond. `time_s`, then per sensor `S1_raw_uV`, `S1_filtered_uV`, `S1_envelope_uV` (100 ms RMS) and `S1_pct_mvc` if calibrated, then `marker`.
   - `…json`: session name and notes, filters, per-sensor calibration, markers, packet counts.

The phone screen is kept awake while sensors are connected. Browsers pause pages that are in the background, so keep the app on screen while recording.

`?demo` adds a simulated sensor, so you can try everything without hardware.

**Hosting:** it's a static site with no build step. It needs HTTPS (or `localhost`) for Bluetooth. Serve `web/` from anywhere: GitHub Pages deploys it automatically from this repo (`.github/workflows/pages.yml`). Locally, run `python3 -m http.server -d web 8000` and open http://localhost:8000.

**Desktop Chrome on Linux** ships Web Bluetooth disabled. Enable `chrome://flags/#enable-experimental-web-platform-features`, and apply the BlueZ setting below.

## Linux: BlueZ connection timing (required)

With BlueZ defaults (45 ms interval, 420 ms supervision timeout), every connection to a MYOblue sensor fails with HCI error `0x3e` ("Connection Failed to be Established"). The dongle uses a 30 ms interval with a 4 s timeout. Match it in `/etc/bluetooth/main.conf` (the `[LE]` keys are there, commented out):

```ini
[LE]
MinConnectionInterval=24
MaxConnectionInterval=24
ConnectionSupervisionTimeout=400
```

Then run `sudo systemctl restart bluetooth`. Android and Windows use longer timeouts by default.

## Bridge (use ELEMYO's GUI without the dongle)

```sh
pip install bleak pyserial
python bridge/myoblue_bridge.py                             # terminal 1: connects to all sensors in range
python bridge/run_elemyo_gui.py ~/MYOBLUE-GUI/MYOblue_GUI.py  # terminal 2: ELEMYO's GUI, unmodified
```

The bridge writes `[0xFF, 0xFF] + packet` to a pty, byte-for-byte what the dongle sends. The launcher lists that pty first in the GUI's port menu and ignores the DTR/RTS calls, which a pty rejects. The GUI's own code is not changed.

## Protocol notes

Measured with the dongle and an HCI trace (`btmon`), and cross-checked against the datasheet.

- **Advertising:** `N_MYOblue_v1.2_XXXXX` (N = module number), static random address, Nordic UART Service UUID `6e400001-b5a3-f393-e0a9-e50e24dcca9e` in the scan response. Advertising is *limited discoverable*: an unconnected sensor goes quiet after a few minutes, so power-cycle it.
- **Data:** notifications on TX `6e400003-…`, 244 bytes each: module (u8), sequence (u24 LE), battery (u16 LE, V = raw / 16384 × 7.2), then 119 samples (u16 LE, 14-bit, 8192 = 0 V; µV = (raw − 8192) × 0.30518, as in MYOblue_GUI). Nominally 1000 samples/s, but the sensor clock runs 2–3% slow: about 975 samples/s, or 8.2 packets/s, the same with or without the dongle.
- **Battery packet:** once a minute the sensor measures its battery instead of EMG and sends a packet whose samples are all 8192. The web app treats it as missing data.
- **What the dongle does:** requests MTU 247 and data length 251, discovers NUS, and enables notifications. No pairing, bonding or writes. It connects to any device advertising that name and service; the sensors don't check the dongle's address.
- **Dongle serial output:** `FF FF` + the 244-byte payload per packet; the baud rate is irrelevant (USB CDC). The dongle's USB serial number is its BLE address.

## License

MIT
