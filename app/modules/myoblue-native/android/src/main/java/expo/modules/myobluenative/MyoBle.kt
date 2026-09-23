package expo.modules.myobluenative

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID

/**
 * Process-wide Bluetooth + recording engine. Lives as long as the app process; the
 * RecordingService keeps the process alive (foreground) while recording, so connections
 * and file writes continue with the screen off or another app (e.g. a call) in front.
 */
@SuppressLint("MissingPermission")
object MyoBle {
  private const val TAG = "MyoBle"
  private val NUS: UUID = UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e")
  private val TX: UUID = UUID.fromString("6e400003-b5a3-f393-e0a9-e50e24dcca9e")
  private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
  private val NAME_RE = Regex("^\\d+_MYOblue")
  const val PACKET_BYTES = 244

  interface Listener {
    fun onDevice(id: String, name: String, rssi: Int)
    fun onSensorState(id: String, name: String, state: String)
    fun onPacket(id: String, data: ByteArray, t: Double)
    fun onMarker(t: Double, label: String)
    fun onRecording(active: Boolean)
  }

  @Volatile var listener: Listener? = null
  private lateinit var ctx: Context
  private val main = Handler(Looper.getMainLooper())
  private val links = HashMap<String, Link>()
  private val seen = HashMap<String, BluetoothDevice>()
  private val lastDeviceEvent = HashMap<String, Long>()
  private var scanning = false

  private class Link(val id: String, var name: String) {
    var gatt: BluetoothGatt? = null
    var wanted = true
    var state = "disconnected"
    var packets = 0L
  }

  fun init(context: Context) {
    if (!::ctx.isInitialized) ctx = context.applicationContext
  }

  fun now(): Double = SystemClock.elapsedRealtimeNanos() / 1e6

  private fun adapter(): BluetoothAdapter? =
    (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

  fun isEnabled(): Boolean = adapter()?.isEnabled == true

  /* ---------------- scanning ---------------- */

  private val scanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) = handle(result)
    override fun onBatchScanResults(results: MutableList<ScanResult>) { results.forEach { handle(it) } }
    override fun onScanFailed(errorCode: Int) { Log.w(TAG, "scan failed $errorCode"); scanning = false }

    private fun handle(r: ScanResult) {
      val name = r.scanRecord?.deviceName ?: try { r.device.name } catch (e: SecurityException) { null } ?: return
      if (!NAME_RE.containsMatchIn(name)) return
      val id = r.device.address
      seen[id] = r.device
      val link = synchronized(links) { links[id] }
      // a wanted sensor that is advertising again: connect right away
      if (link != null && link.wanted && link.gatt == null) main.post { open(link) }
      val nowMs = SystemClock.elapsedRealtime()
      if (nowMs - (lastDeviceEvent[id] ?: 0L) > 800) {
        lastDeviceEvent[id] = nowMs
        listener?.onDevice(id, name, r.rssi)
      }
    }
  }

  fun startScan(): Boolean {
    val scanner = adapter()?.bluetoothLeScanner ?: return false
    if (scanning) return true
    return try {
      val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
      scanner.startScan(null, settings, scanCallback)
      scanning = true
      true
    } catch (e: Exception) {
      Log.w(TAG, "startScan", e); false
    }
  }

  fun stopScan() {
    if (!scanning) return
    scanning = false
    try { adapter()?.bluetoothLeScanner?.stopScan(scanCallback) } catch (e: Exception) { Log.w(TAG, "stopScan", e) }
  }

  /* ---------------- connections ---------------- */

  fun connect(id: String, name: String) {
    val link = synchronized(links) { links.getOrPut(id) { Link(id, name) } }
    if (name.isNotEmpty()) link.name = name
    link.wanted = true
    if (link.gatt == null) main.post { open(link) }
  }

  fun disconnect(id: String) {
    val link = synchronized(links) { links.remove(id) } ?: return
    link.wanted = false
    main.post {
      try { link.gatt?.disconnect(); link.gatt?.close() } catch (e: Exception) { Log.w(TAG, "disconnect", e) }
      link.gatt = null
      setState(link, "disconnected")
    }
  }

  fun sensors(): List<Map<String, Any>> = synchronized(links) {
    links.values.map { mapOf("id" to it.id, "name" to it.name, "state" to it.state, "packets" to it.packets.toDouble()) }
  }

  private fun remoteDevice(id: String): BluetoothDevice? {
    seen[id]?.let { return it }
    val a = adapter() ?: return null
    return try {
      if (Build.VERSION.SDK_INT >= 33) a.getRemoteLeDevice(id, BluetoothDevice.ADDRESS_TYPE_RANDOM)
      else a.getRemoteDevice(id)
    } catch (e: Exception) { null }
  }

  private fun open(link: Link) {
    if (!link.wanted || link.gatt != null) return
    // Before Android 13 a device can't be created with a random address type, so for a
    // sensor not seen yet this session, scan: its advert triggers open() again (see scanCallback)
    if (Build.VERSION.SDK_INT < 33 && !seen.containsKey(link.id)) { startScan(); retry(link, 5000); return }
    val dev = remoteDevice(link.id) ?: run { retry(link, 3000); return }
    setState(link, if (link.packets > 0) "reconnecting" else "connecting")
    try {
      link.gatt = dev.connectGatt(ctx, false, callback(link), BluetoothDevice.TRANSPORT_LE)
    } catch (e: SecurityException) {
      Log.w(TAG, "connectGatt", e)
      setState(link, "failed")
    }
  }

  private fun retry(link: Link, delayMs: Long) {
    main.postDelayed({ if (link.wanted && link.gatt == null) open(link) }, delayMs)
  }

  private fun setState(link: Link, state: String) {
    if (link.state == state) return
    link.state = state
    listener?.onSensorState(link.id, link.name, state)
    RecordingService.refresh()
  }

  private fun callback(link: Link) = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
      if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
        setState(link, "discovering")
        // 244-byte notifications need a larger ATT MTU (the dongle asks for 247 too)
        if (!g.requestMtu(247)) g.discoverServices()
      } else {
        try { g.close() } catch (_: Exception) {}
        if (link.gatt === g) link.gatt = null
        if (link.wanted) {
          setState(link, "reconnecting")
          retry(link, 1500)
        } else setState(link, "disconnected")
      }
    }

    override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
      g.discoverServices()
    }

    override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
      val ch = g.getService(NUS)?.getCharacteristic(TX)
      val desc = ch?.getDescriptor(CCCD)
      if (ch == null || desc == null) { Log.w(TAG, "${link.name}: no NUS TX"); g.disconnect(); return }
      g.setCharacteristicNotification(ch, true)
      val enable = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
      if (Build.VERSION.SDK_INT >= 33) g.writeDescriptor(desc, enable)
      else { @Suppress("DEPRECATION") run { desc.value = enable; g.writeDescriptor(desc) } }
    }

    override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
      if (status == BluetoothGatt.GATT_SUCCESS) setState(link, "live") else g.disconnect()
    }

    override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic, value: ByteArray) {
      packet(link, value)
    }

    @Deprecated("Android < 13")
    @Suppress("DEPRECATION")
    override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic) {
      if (Build.VERSION.SDK_INT < 33) packet(link, ch.value ?: return)
    }
  }

  /** Packets from the demo sensor go through the same path as real ones (recorded too). */
  fun inject(id: String, name: String, data: ByteArray) {
    val link = synchronized(links) { links.getOrPut(id) { Link(id, name).also { it.state = "live" } } }
    link.wanted = false // nothing to reconnect
    packet(link, data)
  }

  private fun packet(link: Link, data: ByteArray) {
    if (data.size < PACKET_BYTES) return
    val t = now()
    link.packets++
    if (link.state != "live") setState(link, "live")
    Recorder.write(link.id, link.name, data, t)
    listener?.onPacket(link.id, data, t)
  }

  /* ---------------- recording ---------------- */

  object Recorder {
    private var dir: File? = null
    private var t0 = 0.0
    private var startedWall = 0L
    private val outs = HashMap<String, FileOutputStream>()
    private val counts = HashMap<String, Long>()
    private val names = LinkedHashMap<String, String>()
    private var markers = 0

    val active: Boolean get() = dir != null

    @Synchronized fun start(path: String, title: String): Boolean {
      if (dir != null) return false
      val d = File(path.removePrefix("file://"))
      d.mkdirs()
      dir = d
      t0 = now()
      startedWall = System.currentTimeMillis()
      outs.clear(); counts.clear(); names.clear(); markers = 0
      RecordingService.start(ctx, title)
      listener?.onRecording(true)
      return true
    }

    @Synchronized fun write(id: String, name: String, data: ByteArray, t: Double) {
      val d = dir ?: return
      val out = outs.getOrPut(id) {
        names[id] = name
        writeSensors(d)
        FileOutputStream(File(d, safe(id) + ".bin"), true)
      }
      val row = ByteBuffer.allocate(8 + PACKET_BYTES).order(ByteOrder.LITTLE_ENDIAN)
      row.putDouble(t - t0).put(data, 0, PACKET_BYTES)
      try { out.write(row.array()) } catch (e: Exception) { Log.w(TAG, "write", e) }
      counts[id] = (counts[id] ?: 0L) + 1
    }

    @Synchronized fun marker(label: String): Double {
      val d = dir ?: return -1.0
      val t = (now() - t0) / 1000.0
      val line = JSONObject().put("t", t).put("label", label).toString() + "\n"
      File(d, "markers.jsonl").appendText(line)
      markers++
      listener?.onMarker(t, label)
      RecordingService.refresh()
      return t
    }

    @Synchronized fun stop(): Map<String, Any>? {
      val d = dir ?: return null
      outs.values.forEach { try { it.flush(); it.close() } catch (_: Exception) {} }
      val durationMs = now() - t0
      val packets = JSONObject()
      counts.forEach { (k, v) -> packets.put(k, v) }
      val status = JSONObject()
        .put("endedAt", iso(System.currentTimeMillis()))
        .put("durationMs", durationMs)
        .put("packets", packets)
      File(d, "status.json").writeText(status.toString(2))
      dir = null
      outs.clear()
      RecordingService.stop(ctx)
      listener?.onRecording(false)
      return mapOf("path" to d.absolutePath, "durationMs" to durationMs, "packets" to counts.values.sum().toDouble())
    }

    @Synchronized fun status(): Map<String, Any>? {
      val d = dir ?: return null
      return mapOf(
        "path" to d.absolutePath,
        "elapsedMs" to now() - t0,
        "startedAt" to startedWall.toDouble(),
        "packets" to counts.values.sum().toDouble(),
        "sensors" to counts.size,
        "markers" to markers,
      )
    }

    private fun writeSensors(d: File) {
      val arr = JSONArray()
      names.forEach { (id, n) -> arr.put(JSONObject().put("id", id).put("name", n).put("file", safe(id) + ".bin")) }
      File(d, "sensors.json").writeText(arr.toString(2))
    }

    fun safe(id: String) = id.replace(Regex("[^A-Za-z0-9_-]"), "")

    private fun iso(ms: Long): String {
      val f = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US)
      f.timeZone = java.util.TimeZone.getTimeZone("UTC")
      return f.format(java.util.Date(ms))
    }
  }

  fun liveCount(): Int = synchronized(links) { links.values.count { it.state == "live" } }

  fun openBatterySettings(context: Context) {
    val i = Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
      .setData(android.net.Uri.parse("package:" + context.packageName))
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try { context.startActivity(i) } catch (e: Exception) {
      context.startActivity(Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }

  fun ignoringBatteryOptimizations(context: Context): Boolean {
    val pm = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
    return pm.isIgnoringBatteryOptimizations(context.packageName)
  }
}
