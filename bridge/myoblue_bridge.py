#!/usr/bin/env python3
"""Software replacement for the ELEMYO MYOblue USB dongle.

Connects to MYOblue sensors with the computer's own Bluetooth and writes the
same byte stream the dongle does ([0xFF, 0xFF] + 244-byte packet) to a
virtual serial port, so MYOblue_GUI can read it (via run_elemyo_gui.py).
"""
import argparse
import asyncio
import os
import pty
import re
import sys
import termios
import time
import tty
from pathlib import Path

from bleak import BleakClient, BleakScanner

TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"  # Nordic UART Service TX (notify)
NAME_RE = re.compile(r"^\d+_MYOblue")
HEADER = b"\xff\xff"
PORT_FILE = Path(os.environ.get("XDG_RUNTIME_DIR", "/tmp")) / "myoblue-bridge.port"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class VirtualPort:
    """A pty whose slave end looks like the dongle's serial port."""

    def __init__(self):
        self.master, self.slave = pty.openpty()
        tty.setraw(self.slave)  # no newline translation or echo
        attrs = termios.tcgetattr(self.slave)
        attrs[3] &= ~termios.ECHO
        termios.tcsetattr(self.slave, termios.TCSANOW, attrs)
        os.set_blocking(self.master, False)
        self.path = os.ttyname(self.slave)
        self.dropped = 0

    def write(self, data: bytes):
        try:
            os.write(self.master, data)
        except BlockingIOError:
            self.dropped += 1  # nobody is reading; don't stall the BLE side


class Sensor:
    def __init__(self, device, port, stats):
        self.device, self.port, self.stats = device, port, stats
        self.name = device.name or device.address

    def on_notify(self, _, data: bytearray):
        self.port.write(HEADER + bytes(data))
        self.stats[self.name] = self.stats.get(self.name, 0) + 1

    async def run(self, connect_lock):
        while True:
            try:
                async with connect_lock:  # BlueZ handles one pending connect at a time
                    client = BleakClient(self.device, timeout=20)
                    await client.connect()
                await client.start_notify(TX_UUID, self.on_notify)
                log(f"{self.name}: streaming")
                while client.is_connected:
                    await asyncio.sleep(0.5)
                log(f"{self.name}: disconnected")
            except Exception as e:
                log(f"{self.name}: connect failed ({type(e).__name__}); retrying")
            await asyncio.sleep(1)
            fresh = await BleakScanner.find_device_by_address(self.device.address, timeout=10)
            if fresh:
                self.device = fresh


def check_bluez_timing():
    try:
        conf = Path("/etc/bluetooth/main.conf").read_text()
    except OSError:
        return
    if not re.search(r"^ConnectionSupervisionTimeout\s*=", conf, re.M):
        log("WARNING: BlueZ uses a 420 ms supervision timeout by default and MYOblue sensors drop those "
            "connections. Set ConnectionSupervisionTimeout=400 (and Min/MaxConnectionInterval=24) "
            "under [LE] in /etc/bluetooth/main.conf, then restart bluetooth. See README.")


async def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--stats", type=float, default=10, help="seconds between packet-rate logs (0 = off)")
    args = ap.parse_args()

    check_bluez_timing()
    port = VirtualPort()
    PORT_FILE.write_text(port.path)
    log(f"virtual dongle port: {port.path}  (advertised in {PORT_FILE})")

    stats, known, lock = {}, set(), asyncio.Lock()

    def found(device, adv):
        name = device.name or adv.local_name or ""
        if NAME_RE.match(name) and device.address not in known:
            known.add(device.address)
            log(f"found {name} ({device.address})")
            asyncio.get_running_loop().create_task(Sensor(device, port, stats).run(lock))

    scanner = BleakScanner(found)
    await scanner.start()
    log("scanning for MYOblue sensors (switch them on; unplug the real dongle)")
    try:
        last = time.time()
        while True:
            await asyncio.sleep(1)
            if args.stats and time.time() - last >= args.stats:
                dt, last = time.time() - last, time.time()
                if stats:
                    rates = ", ".join(f"{k}: {v / dt:.1f} pkt/s" for k, v in sorted(stats.items()))
                    log(f"{rates}  (1 kHz = 8.4 pkt/s){'  dropped: ' + str(port.dropped) if port.dropped else ''}")
                stats.clear()
    finally:
        await scanner.stop()
        PORT_FILE.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
