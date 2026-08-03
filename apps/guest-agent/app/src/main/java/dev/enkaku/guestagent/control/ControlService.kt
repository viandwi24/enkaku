package dev.enkaku.guestagent.control

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.os.Build
import android.os.IBinder
import android.util.Log
import dev.enkaku.guestagent.R
import dev.enkaku.guestagent.route.DeadMansSwitch
import dev.enkaku.guestagent.route.RouteState
import dev.enkaku.guestagent.route.RouteVpnService
import dev.enkaku.guestagent.route.Socks5Upstream
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONArray
import org.json.JSONObject

/**
 * Owns the control channel: an abstract-namespace socket the farm host reaches over
 * `adb forward localabstract:enkaku-guest-agent`.
 *
 * It runs as a foreground service of type `specialUse`. That type is chosen deliberately over
 * `systemExempted`: its documented runtime prerequisites are "None", it is not on Android 15's list
 * of types a BOOT_COMPLETED receiver may not start, and it is not subject to Android 15's 6h/24h
 * foreground-service timeout. See docs/plans/43-m15b-guest-agent.md §4.4 for the unresolved
 * contradiction in the platform docs about `systemExempted`, which is why we avoid it.
 */
class ControlService : Service() {

  private val running = AtomicBoolean(false)
  /**
   * Backstop for a farm that vanishes. Host-side lease teardown is the normal path; this covers the
   * case where the host is the thing that died and so runs no cleanup at all.
   */
  private val deadMan = DeadMansSwitch { RouteVpnService.stop(this) }
  private var server: LocalServerSocket? = null
  private val workers = Executors.newCachedThreadPool()
  private var acceptThread: Thread? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    startInForeground()
    startListening()
    deadMan.start()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // The host re-launches BootstrapActivity on every provisioning pass, which regenerates the
    // token; a redelivered intent must never resurrect a stale one.
    intent?.getStringExtra(EXTRA_TOKEN)?.let { Pairing.setToken(it) }
    return START_STICKY
  }

  override fun onDestroy() {
    deadMan.stop()
    running.set(false)
    runCatching { server?.close() }
    workers.shutdownNow()
    acceptThread?.interrupt()
    super.onDestroy()
  }

  private fun startInForeground() {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    // minSdk is 29, so notification channels are unconditional here.
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Device farm agent", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Keeps the Enkaku control channel available to the farm host."
        setShowBadge(false)
      },
    )

    val notification: Notification =
      Notification.Builder(this, CHANNEL_ID)
        .setContentTitle("Enkaku guest agent")
        .setContentText("Managed by a device farm host.")
        .setSmallIcon(R.mipmap.ic_launcher)
        .setOngoing(true)
        .build()

    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun startListening() {
    if (!running.compareAndSet(false, true)) return
    acceptThread =
      Thread({
          try {
            LocalServerSocket(Protocol.SOCKET_NAME).use { socket ->
              server = socket
              Log.i(TAG, "control channel listening on localabstract:${Protocol.SOCKET_NAME}")
              while (running.get()) {
                val client = socket.accept()
                workers.execute { serve(client) }
              }
            }
          } catch (t: Throwable) {
            // A closed socket during shutdown is expected; anything else is worth surfacing, since
            // the host reports an unreachable channel as `unreachable` rather than `ready`.
            if (running.get()) Log.e(TAG, "control channel stopped", t)
          }
        },
        "enkaku-control-accept",
      )
        .also { it.isDaemon = true }
        .also { it.start() }
  }

  /** One connection, newline-delimited JSON, one response per request, until the peer closes. */
  private fun serve(client: LocalSocket) {
    client.use {
      val reader = BufferedReader(InputStreamReader(it.inputStream, Charsets.UTF_8))
      val writer = BufferedWriter(OutputStreamWriter(it.outputStream, Charsets.UTF_8))
      while (running.get()) {
        val line = reader.readLine() ?: return
        if (line.isBlank()) continue
        val response = runCatching { handle(line) }
          .getOrElse { err ->
            Log.w(TAG, "request failed", err)
            error(null, Protocol.ERR_BAD_REQUEST, err.message ?: "malformed request")
          }
        writer.write(response.toString())
        writer.write("\n")
        writer.flush()
      }
    }
  }

  private fun handle(line: String): JSONObject {
    val request = JSONObject(line)
    val id = request.optString("id").takeIf { it.isNotEmpty() }
    val method = request.optString("method")
    if (method.isEmpty()) return error(id, Protocol.ERR_BAD_REQUEST, "missing method")

    // Authorisation lives in the payload, not in a component permission. BootstrapActivity and this
    // service must both be exported for `adb shell am` to reach them at all, and a signature-level
    // permission would block the shell too — it is not signed with our key.
    // See docs/research/android-guest-agent.md §1.1.
    val token = request.optString("token")
    if (!Pairing.hasToken()) return error(id, Protocol.ERR_NOT_PAIRED, "no host has paired yet")
    if (!Pairing.matches(token)) return error(id, Protocol.ERR_UNAUTHORISED, "bad or missing token")

    // Any authorised request proves the farm is still there — including the core's heartbeat.
    deadMan.touch()

    return when (method) {
      Protocol.METHOD_HELLO ->
        ok(id) {
          put("protocol", Protocol.PROTOCOL_VERSION)
          put("appVersion", appVersion())
          put("androidSdkInt", Build.VERSION.SDK_INT)
          put("capabilities", JSONArray(Protocol.CAPABILITIES))
        }
      Protocol.METHOD_PING -> ok(id) { put("pong", true) }

      Protocol.METHOD_ROUTE_START -> {
        val cfg = request.optJSONObject("config")
          ?: return error(id, Protocol.ERR_BAD_REQUEST, "missing config")
        val host = cfg.optString("host").takeIf { it.isNotEmpty() }
          ?: return error(id, Protocol.ERR_BAD_REQUEST, "missing host")
        val port = cfg.optInt("port", -1).takeIf { it in 1..65535 }
          ?: return error(id, Protocol.ERR_BAD_REQUEST, "port must be 1..65535")
        // Distinguish "consent was never pre-granted" from "the upstream is unreachable"; the host
        // shows a different repair action for each, so collapsing them would misdirect the operator.
        if (!RouteVpnService.isPrepared(this)) {
          return error(id, Protocol.ERR_NOT_PREPARED, "VPN consent not granted for this package")
        }
        RouteVpnService.start(
          this,
          Socks5Upstream(
            host = host,
            port = port,
            username = cfg.optString("username").takeIf { it.isNotEmpty() },
            password = cfg.optString("password").takeIf { it.isNotEmpty() },
            udpMode = cfg.optString("udpMode").takeIf { it.isNotEmpty() } ?: "udp",
          ),
        )
        ok(id) { put("started", true) }
      }

      Protocol.METHOD_ROUTE_STOP -> {
        RouteVpnService.stop(this)
        ok(id) { put("stopped", true) }
      }

      // Observation, not intent: what the device reports right now. The host compares this against
      // what it asked for and surfaces the difference rather than assuming they agree.
      Protocol.METHOD_ROUTE_STATUS ->
        ok(id) {
          put("prepared", RouteVpnService.isPrepared(this@ControlService))
          put("up", RouteState.isUp())
          put("upstream", RouteState.describeUpstream())
          put("lastError", RouteState.lastError())
          RouteState.stats()?.let { put("stats", JSONArray(it.toTypedArray())) }
        }

      else -> error(id, Protocol.ERR_UNKNOWN_METHOD, "unknown method: $method")
    }
  }

  private fun appVersion(): String =
    runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull() ?: "unknown"

  private inline fun ok(id: String?, body: JSONObject.() -> Unit): JSONObject =
    JSONObject().apply {
      id?.let { put("id", it) }
      put("ok", true)
      put("result", JSONObject().apply(body))
    }

  private fun error(id: String?, code: String, message: String): JSONObject =
    JSONObject().apply {
      id?.let { put("id", it) }
      put("ok", false)
      put("error", JSONObject().apply {
        put("code", code)
        put("message", message)
      })
    }

  companion object {
    private const val TAG = "EnkakuGuestAgent"
    private const val CHANNEL_ID = "enkaku-control"
    private const val NOTIFICATION_ID = 1
    const val EXTRA_TOKEN = "token"

    fun start(context: Context, token: String?) {
      val intent = Intent(context, ControlService::class.java).putExtra(EXTRA_TOKEN, token)
      context.startForegroundService(intent)
    }
  }
}
