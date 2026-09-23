package expo.modules.myobluenative

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager

/**
 * Foreground service for the duration of a recording. It owns no Bluetooth state itself
 * (that is MyoBle); its job is to keep the process running and visible to the user:
 * ongoing notification with elapsed time, live sensor count and Mark / Stop actions,
 * plus a partial wake lock so the CPU keeps writing packets with the screen off.
 */
class RecordingService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var wakeLock: PowerManager.WakeLock? = null
  private var title = "Recording"

  private val tick = object : Runnable {
    override fun run() {
      if (!MyoBle.Recorder.active) return
      notifyNow()
      handler.postDelayed(this, 1000)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_MARK -> { MyoBle.Recorder.marker("mark"); return START_NOT_STICKY }
      ACTION_STOP -> { MyoBle.Recorder.stop(); return START_NOT_STICKY }
      ACTION_REFRESH -> { if (MyoBle.Recorder.active) notifyNow(); return START_NOT_STICKY }
    }
    title = intent?.getStringExtra(EXTRA_TITLE) ?: title
    createChannel()
    val n = build()
    if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    else startForeground(NOTIFICATION_ID, n)
    if (wakeLock == null) {
      val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "myoblue:recording").apply {
        setReferenceCounted(false)
        acquire(12 * 60 * 60 * 1000L) // safety cap: 12 h
      }
    }
    handler.removeCallbacks(tick)
    handler.post(tick)
    instance = this
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    handler.removeCallbacks(tick)
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    if (instance === this) instance = null
    super.onDestroy()
  }

  /** Swiping the app away from recents must not end the recording. */
  override fun onTaskRemoved(rootIntent: Intent?) {}

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < 26) return
    val nm = getSystemService(NotificationManager::class.java)
    if (nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(NotificationChannel(CHANNEL, "Recording", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown while MYOblue is recording"
        setShowBadge(false)
      })
    }
  }

  private fun notifyNow() {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.notify(NOTIFICATION_ID, build())
  }

  private fun pending(action: String, code: Int): PendingIntent =
    PendingIntent.getService(this, code, Intent(this, RecordingService::class.java).setAction(action),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

  @Suppress("DEPRECATION")
  private fun build(): Notification {
    val status = MyoBle.Recorder.status()
    val elapsed = ((status?.get("elapsedMs") as? Double) ?: 0.0) / 1000
    val h = (elapsed / 3600).toInt(); val m = ((elapsed / 60) % 60).toInt(); val s = (elapsed % 60).toInt()
    val clock = if (h > 0) String.format("%d:%02d:%02d", h, m, s) else String.format("%02d:%02d", m, s)
    val live = MyoBle.liveCount()
    val markers = (status?.get("markers") as? Int) ?: 0
    val text = "$clock · $live sensor${if (live == 1) "" else "s"} live · $markers marker${if (markers == 1) "" else "s"}"
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
    b.setContentTitle("Recording · $title")
      .setContentText(text)
      .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setCategory(Notification.CATEGORY_SERVICE)
      .addAction(Notification.Action.Builder(null, "Mark", pending(ACTION_MARK, 1)).build())
      .addAction(Notification.Action.Builder(null, "Stop", pending(ACTION_STOP, 2)).build())
    if (open != null) b.setContentIntent(open)
    if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
    return b.build()
  }

  companion object {
    private const val CHANNEL = "myoblue_recording"
    private const val NOTIFICATION_ID = 4711
    private const val ACTION_MARK = "expo.modules.myobluenative.MARK"
    private const val ACTION_STOP = "expo.modules.myobluenative.STOP"
    private const val ACTION_REFRESH = "expo.modules.myobluenative.REFRESH"
    private const val EXTRA_TITLE = "title"
    @Volatile private var instance: RecordingService? = null

    fun start(ctx: Context, title: String) {
      val i = Intent(ctx, RecordingService::class.java).putExtra(EXTRA_TITLE, title)
      if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
    }

    fun stop(ctx: Context) {
      instance?.let {
        it.stopForeground(Service.STOP_FOREGROUND_REMOVE)
        it.stopSelf()
      } ?: ctx.stopService(Intent(ctx, RecordingService::class.java))
    }

    /** Update the notification now (sensor connected/lost, marker added). */
    fun refresh() {
      instance?.let { svc -> svc.handler.post { if (MyoBle.Recorder.active) svc.notifyNow() } }
    }
  }
}
