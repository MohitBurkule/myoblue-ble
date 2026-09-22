#!/usr/bin/env python3
"""Run ELEMYO's unmodified MYOblue_GUI.py against the myoblue_bridge virtual port.

Usage: python run_elemyo_gui.py /path/to/MYOBLUE-GUI/MYOblue_GUI.py

The GUI only lists real serial devices and sets DTR/RTS, which a pty rejects.
This launcher patches pyserial so the bridge's port is listed first and the
modem-line calls are ignored on it, then runs the GUI as-is.
"""
import os
import runpy
import sys
from pathlib import Path

import serial
import serial.serialposix
import serial.tools.list_ports
import serial.tools.list_ports_common

PORT_FILE = Path(os.environ.get("XDG_RUNTIME_DIR", "/tmp")) / "myoblue-bridge.port"


def bridge_port():
    try:
        p = PORT_FILE.read_text().strip()
        return p if os.path.exists(p) else None
    except OSError:
        return None


_comports = serial.tools.list_ports.comports


def comports(*a, **kw):
    ports = list(_comports(*a, **kw))
    p = bridge_port()
    if p:
        info = serial.tools.list_ports_common.ListPortInfo(p, skip_link_detection=True)
        info.description = "MYOblue BLE bridge"
        ports.insert(0, info)
    return ports


serial.tools.list_ports.comports = comports


def quiet(fn):
    def wrapper(self):
        if self.port == bridge_port():
            return  # a pty has no modem lines; the real dongle ignores them anyway
        return fn(self)
    return wrapper


serial.serialposix.Serial._update_dtr_state = quiet(serial.serialposix.Serial._update_dtr_state)
serial.serialposix.Serial._update_rts_state = quiet(serial.serialposix.Serial._update_rts_state)

if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    gui = Path(sys.argv[1]).resolve()
    if not bridge_port():
        print(">>> myoblue_bridge.py is not running; the GUI will only see real serial ports.")
    os.chdir(gui.parent)  # GUI reads config.ini and img/ relative to cwd
    sys.argv = [str(gui)]
    runpy.run_path(str(gui), run_name="__main__")
