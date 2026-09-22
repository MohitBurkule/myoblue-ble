# Pretend to be a MYOblue sensor (Nordic UART Service) so a real dongle connects to it.
# Sends a synthetic 50 Hz sine in the sensor packet format. Linux/BlueZ, needs `bless`.
# Usage: python fake_sensor.py [name]
import asyncio, math, struct, sys, time
from bless import BlessServer, GATTCharacteristicProperties as P, GATTAttributePermissions as A

NAME = sys.argv[1] if len(sys.argv) > 1 else "1_MYOblue_v1.2_7F3A3"
NUS = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"  # central -> sensor
TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"  # sensor -> central (notify)

def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)

def on_write(ch, value, **kw):
    log("WRITE", ch.uuid, bytes(value).hex(" "))
    ch.value = value

def on_read(ch, **kw):
    log("READ", ch.uuid)
    return ch.value

async def main():
    srv = BlessServer(name=NAME)
    srv.read_request_func = on_read
    srv.write_request_func = on_write
    await srv.add_new_service(NUS)
    await srv.add_new_characteristic(NUS, RX, P.write | P.write_without_response, None, A.writeable)
    await srv.add_new_characteristic(NUS, TX, P.notify, None, A.readable)
    await srv.start()
    log("advertising as", NAME)
    seq, t0, last_conn = 0, time.time(), None
    while True:
        conn = await srv.is_connected()
        if conn != last_conn:
            log("CONNECTED" if conn else "not connected"); last_conn = conn
        if conn:
            # module(1) seq(3, LE) battery(2) + 119 samples: a 50 Hz sine around 8192
            samples = [int(8192 + 2000 * math.sin(2 * math.pi * 50 * ((seq * 119 + i) / 1000))) for i in range(119)]
            pkt = bytes([1]) + seq.to_bytes(3, "little") + struct.pack("<H", 3000) + struct.pack("<119H", *samples)
            srv.get_characteristic(TX).value = bytearray(pkt)
            srv.update_value(NUS, TX)
            seq += 1
        await asyncio.sleep(0.119)

asyncio.run(main())
