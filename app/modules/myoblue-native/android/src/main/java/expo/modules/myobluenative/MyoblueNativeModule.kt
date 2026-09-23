package expo.modules.myobluenative

import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** JS bridge for MyoBle (Bluetooth + recording). Packets are sent to JS base64-encoded. */
class MyoblueNativeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MyoblueNative")

    Events("onDevice", "onSensorState", "onPacket", "onMarker", "onRecording")

    OnCreate {
      val context = appContext.reactContext ?: return@OnCreate
      MyoBle.init(context)
      MyoBle.listener = object : MyoBle.Listener {
        override fun onDevice(id: String, name: String, rssi: Int) =
          sendEvent("onDevice", mapOf("id" to id, "name" to name, "rssi" to rssi))
        override fun onSensorState(id: String, name: String, state: String) =
          sendEvent("onSensorState", mapOf("id" to id, "name" to name, "state" to state))
        override fun onPacket(id: String, data: ByteArray, t: Double) =
          sendEvent("onPacket", mapOf("id" to id, "data" to Base64.encodeToString(data, Base64.NO_WRAP), "t" to t))
        override fun onMarker(t: Double, label: String) =
          sendEvent("onMarker", mapOf("t" to t, "label" to label))
        override fun onRecording(active: Boolean) =
          sendEvent("onRecording", mapOf("active" to active))
      }
    }

    OnDestroy { MyoBle.listener = null }

    Function("isBluetoothOn") { MyoBle.isEnabled() }
    Function("startScan") { MyoBle.startScan() }
    Function("stopScan") { MyoBle.stopScan() }
    Function("connect") { id: String, name: String -> MyoBle.connect(id, name) }
    Function("disconnect") { id: String -> MyoBle.disconnect(id) }
    Function("sensors") { MyoBle.sensors() }
    Function("now") { MyoBle.now() }
    Function("injectPacket") { id: String, name: String, data: String ->
      MyoBle.inject(id, name, Base64.decode(data, Base64.NO_WRAP))
    }

    Function("startRecording") { path: String, title: String -> MyoBle.Recorder.start(path, title) }
    Function("stopRecording") { MyoBle.Recorder.stop() }
    Function("addMarker") { label: String -> MyoBle.Recorder.marker(label) }
    Function("recordingStatus") { MyoBle.Recorder.status() }

    Function("ignoringBatteryOptimizations") {
      val context = appContext.reactContext ?: return@Function true
      MyoBle.ignoringBatteryOptimizations(context)
    }
    Function("openBatterySettings") {
      val context = appContext.reactContext
      if (context != null) MyoBle.openBatterySettings(context)
    }
  }
}
