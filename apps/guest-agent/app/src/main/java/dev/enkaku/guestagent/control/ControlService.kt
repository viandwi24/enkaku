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
import dev.enkaku.guestagent.identity.MockLocation
import dev.enkaku.guestagent.input.TextFacet
import dev.enkaku.guestagent.label.WallpaperFacet
import dev.enkaku.guestagent.route.DeadMansSwitch
import dev.enkaku.guestagent.route.EgressProbe
import dev.enkaku.guestagent.route.Ipv6Leak
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
   * case where the host is the thing that died and so runs no cleanup at all. Holds the route
   * closed rather than tearing it down (plan 54 §3.1) — `RouteVpnService.hold()` re-derives whether
   * this device's route actually wants that (`failClosed`) or the pre-plan-54 tear-down, so this
   * lambda does not have to know the policy itself.
   */
  private val deadMan = DeadMansSwitch { reason -> RouteVpnService.hold(this, reason) }
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
    ControlChannelState.markStopped(null)
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
              ControlChannelState.markListening()
              Log.i(TAG, "control channel listening on localabstract:${Protocol.SOCKET_NAME}")
              while (running.get()) {
                val client = socket.accept()
                workers.execute { serve(client) }
              }
            }
          } catch (t: Throwable) {
            // A closed socket during shutdown is expected; anything else is worth surfacing, since
            // the host reports an unreachable channel as `unreachable` rather than `ready`.
            if (running.get()) {
              Log.e(TAG, "control channel stopped", t)
              // Only a loop that died on its own carries a reason — a shutdown-time close is
              // already covered by `onDestroy`'s own `markStopped(null)`, and reporting it as a
              // failure on the status screen would be a lie about an ordinary stop.
              ControlChannelState.markStopped(t.message ?: t.javaClass.simpleName)
            } else {
              ControlChannelState.markStopped(null)
            }
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
    if (!Pairing.hasToken()) {
      ControlChannelState.recordRejection(Protocol.ERR_NOT_PAIRED)
      return error(id, Protocol.ERR_NOT_PAIRED, "no host has paired yet")
    }
    if (!Pairing.matches(token)) {
      ControlChannelState.recordRejection(Protocol.ERR_UNAUTHORISED)
      return error(id, Protocol.ERR_UNAUTHORISED, "bad or missing token")
    }

    // Any authorised request proves the farm is still there — including the core's heartbeat.
    deadMan.touch()
    // The same proof, kept where a human can read it: `StatusActivity` renders "last contact" off
    // this, and the dead-man's switch's own `lastContact` is private to it by design.
    ControlChannelState.recordRequest(method)

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
            // Plan 54 §4.2, §5.6 — defaults true (fail-closed, the safe reading) when the host
            // omits it, same as `Socks5Upstream`'s own default.
            failClosed = cfg.optBoolean("failClosed", true),
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
          // Plan 54 §4.1, §5.3 — the state `up` alone could never distinguish: `held` (fail-closed,
          // deliberate) reads identically to `down` (nothing configured) through `up` on its own.
          put("state", RouteState.current().name.lowercase())
          put("upstream", RouteState.describeUpstream())
          put("lastError", RouteState.lastError())
          RouteState.stats()?.let { put("stats", JSONArray(it.toTypedArray())) }
          // Plan 51 §4.5, §5.7 — asserted, not assumed: reads back `LinkProperties` off
          // `ConnectivityManager` rather than trusting that `RouteVpnService`'s own
          // `addRoute("::", 0)` request was actually honoured by the OS. Absent (not `null`) when
          // no VPN network can currently be found to ask — see `Ipv6Leak.isBlocked`'s doc comment.
          Ipv6Leak.isBlocked(this@ControlService)?.let { put("ipv6Blocked", it) }
        }

      // Plan 55 §3.5, §4.1, §5.6 — forces the SAME hold-closed transition the dead-man's switch
      // reaches on its own (`RouteVpnService.hold`), but triggered by the HOST: a `geo` check
      // failure is decided on the host (only it runs the lookup), so unlike every other hold
      // trigger this one has to be told rather than noticed on-device.
      Protocol.METHOD_ROUTE_HOLD -> {
        val reason = request.optString("reason").takeIf { it.isNotEmpty() }
          ?: return error(id, Protocol.ERR_BAD_REQUEST, "missing reason")
        RouteVpnService.hold(this, reason)
        ok(id) { put("held", true) }
      }

      // Plan 51 §4.2, §5.4. `EgressProbe.run` itself never throws — a leg that could not connect
      // or fetch is reported as `{ok:false, error, stage}`, not an exception — so this always
      // answers `ok(id)`; only a malformed request (missing/invalid url or timeoutMs) is an
      // error reply.
      Protocol.METHOD_EGRESS_PROBE -> {
        val url = request.optString("url").takeIf { it.isNotEmpty() }
          ?: return error(id, Protocol.ERR_BAD_REQUEST, "missing url")
        val timeoutMs = request.optInt("timeoutMs", -1).takeIf { it in 1..60_000 }
          ?: return error(id, Protocol.ERR_BAD_REQUEST, "timeoutMs must be 1..60000")
        // Runs on RouteVpnService's own single-thread `ops` executor when a route is active
        // (serialising against a concurrent start()/teardown()), or on this request's own
        // worker thread otherwise — never the main thread either way. See
        // `RouteVpnService.submitProbe`'s doc comment. Budget is `timeoutMs * 2` because
        // `EgressProbe.run` measures BOTH legs sequentially, each individually bounded by
        // `timeoutMs` — plus slack for dispatch overhead on the `ops` executor.
        val result = RouteVpnService.submitProbe(timeoutMs.toLong() * 2 + PROBE_BUDGET_SLACK_MS) {
          EgressProbe.run(url, timeoutMs)
        }
        ok(id) {
          put("tunnelled", result.tunnelled.toJson())
          put("direct", result.direct.toJson())
        }
      }

      // Plan 58 §4.4, §5.4 — installs a mock GPS fix via MockLocation's test-provider wrapper.
      // `lat`/`lng` are re-validated here (never trust the wire even though the host's own Zod
      // schema already bounds them) because this socket is reached by anything that knows the
      // token, same reasoning as ROUTE_START's port check.
      Protocol.METHOD_LOCATION_SET -> {
        if (!request.has("lat") || !request.has("lng")) {
          return error(id, Protocol.ERR_BAD_REQUEST, "missing lat/lng")
        }
        val lat = request.optDouble("lat", Double.NaN)
        val lng = request.optDouble("lng", Double.NaN)
        if (lat.isNaN() || lat < -90.0 || lat > 90.0) {
          return error(id, Protocol.ERR_BAD_REQUEST, "lat must be -90..90")
        }
        if (lng.isNaN() || lng < -180.0 || lng > 180.0) {
          return error(id, Protocol.ERR_BAD_REQUEST, "lng must be -180..180")
        }
        val accuracy = request.optDouble("accuracy", 100.0).toFloat()
        try {
          MockLocation.set(this, lat, lng, accuracy)
        } catch (se: SecurityException) {
          // Same code RouteVpnService's missing-VPN-consent path uses (METHOD_ROUTE_START above)
          // — an operator precondition is missing, not a malformed request.
          return error(
            id,
            Protocol.ERR_NOT_PREPARED,
            "not the device's mock-location app — grant it first (adb shell appops set <pkg> android:mock_location allow)",
          )
        }
        ok(id) { put("set", true) }
      }

      Protocol.METHOD_LOCATION_CLEAR -> {
        MockLocation.clear(this)
        ok(id) { put("cleared", true) }
      }

      // Plan 90 §3.2, §3.3, §4.1, §4.2 — commits through the live EnkakuIme instance via
      // TextFacet's static weak reference. `perCharMs` is re-validated here (never trust the wire
      // even though the host's own Zod already bounds it — the same reasoning ROUTE_START's port
      // check and LOCATION_SET's lat/lng re-validation already use).
      Protocol.METHOD_TEXT_COMMIT -> {
        if (!request.has("text")) return error(id, Protocol.ERR_BAD_REQUEST, "missing text")
        val text = request.optString("text")
        val perCharMsArray = request.optJSONArray("perCharMs")
        val perCharMs = if (perCharMsArray != null) {
          if (perCharMsArray.length() != 2) {
            return error(id, Protocol.ERR_BAD_REQUEST, "perCharMs must be a [min, max] pair")
          }
          val min = perCharMsArray.optLong(0, -1)
          val max = perCharMsArray.optLong(1, -1)
          if (min < 0 || max < 0) {
            return error(id, Protocol.ERR_BAD_REQUEST, "perCharMs values must be non-negative")
          }
          min to max
        } else {
          null
        }
        val outcome = TextFacet.commit(this, text, perCharMs)
        ok(id) {
          put("committed", outcome.committed)
          put("ime", if (outcome.current) "current" else "not-current")
        }
      }

      Protocol.METHOD_TEXT_STATUS -> {
        val status = TextFacet.status(this)
        ok(id) {
          put("ime", status.ime)
          put("id", status.id)
          put("connected", status.connected)
        }
      }

      // Plan 89 §4.5; plan 90 §3.6, §4.1, §4.2 (Task B — no step in plan 90 assigned this facet;
      // see this file's own header note below `label.clear`). Same wire re-validation discipline
      // as every other branch above: the host's Zod already bounds these, but this socket is
      // reached by anything holding the pairing token, not only the host.
      Protocol.METHOD_LABEL_APPLY -> {
        val fingerprint = request.optString("fingerprint").takeIf { it.isNotEmpty() }
          ?: return error(id, Protocol.ERR_BAD_REQUEST, "missing fingerprint")
        val number = request.optString("number").takeIf { it.isNotEmpty() }
          ?: return error(id, Protocol.ERR_BAD_REQUEST, "missing number")
        // `name` is REQUIRED as a key (nullable, not optional) on the wire schema
        // (`LabelApplyRequestSchema`) — `null` means number-only, a missing key is a bad request.
        if (!request.has("name")) return error(id, Protocol.ERR_BAD_REQUEST, "missing name")
        val name = if (request.isNull("name")) null else request.optString("name").takeIf { it.isNotEmpty() }
        val surfacesArray = request.optJSONArray("surfaces")
          ?: return error(id, Protocol.ERR_BAD_REQUEST, "missing surfaces")
        val surfaces = (0 until surfacesArray.length()).map { surfacesArray.optString(it) }
        if (surfaces.isEmpty() || surfaces.any { it != "home" && it != "lock" }) {
          return error(id, Protocol.ERR_BAD_REQUEST, "surfaces must be a non-empty array of 'home'/'lock'")
        }
        val result = WallpaperFacet.apply(this, fingerprint, number, name, surfaces)
        ok(id) {
          put("applied", JSONArray(result.applied))
          put("fingerprint", result.fingerprint)
          put("rendererVersion", result.rendererVersion)
          put("widthPx", result.widthPx)
          put("heightPx", result.heightPx)
          putOrNull(this, "wallpaperIdHome", result.wallpaperIdHome)
          putOrNull(this, "wallpaperIdLock", result.wallpaperIdLock)
        }
      }

      Protocol.METHOD_LABEL_STATUS -> {
        val status = WallpaperFacet.status(this)
        ok(id) {
          putOrNull(this, "fingerprint", status.fingerprint)
          put("matchesOurs", status.matchesOurs)
          putOrNull(this, "wallpaperIdHome", status.wallpaperIdHome)
          putOrNull(this, "wallpaperIdLock", status.wallpaperIdLock)
          put("originalCaptured", status.originalCaptured)
          put("rendererVersion", status.rendererVersion)
        }
      }

      Protocol.METHOD_LABEL_CLEAR -> {
        if (!request.has("restoreOriginal")) {
          return error(id, Protocol.ERR_BAD_REQUEST, "missing restoreOriginal")
        }
        val restoreOriginal = request.optBoolean("restoreOriginal")
        val result = WallpaperFacet.clear(this, restoreOriginal)
        ok(id) {
          put("restored", result.restored)
          // `LabelClearResultSchema.fingerprint` is `z.null()` — always JSON null, never absent.
          put("fingerprint", JSONObject.NULL)
        }
      }

      else -> error(id, Protocol.ERR_UNKNOWN_METHOD, "unknown method: $method")
    }
  }

  /** Mirrors `EgressProbeLegSchema` in `packages/protocol/src/guest-agent.ts` field for field — both sides change together. */
  private fun EgressProbe.Leg.toJson(): JSONObject =
    JSONObject().apply {
      put("ok", ok)
      status?.let { put("status", it) }
      body?.let { put("body", it) }
      put("ms", ms)
      error?.let { put("error", it) }
      stage?.let { put("stage", it) }
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

  /**
   * `org.json.JSONObject.put(key, value)` REMOVES the key outright when [value] is a Java `null`
   * — it does not emit a JSON `null` (see the doc comment on `RouteStatusResultSchema` in
   * `packages/protocol/src/guest-agent.ts`, which is why every field there is `.optional()` rather
   * than `.nullable()`). The label schemas are the first ones on this wire that ARE genuinely
   * `.nullable()` (`LabelApplyResultSchema.wallpaperIdHome`, etc.) — present, possibly `null` —
   * so this writes the [JSONObject.NULL] sentinel explicitly instead of relying on `put`'s
   * default removal behaviour. Takes [obj] explicitly (not a `JSONObject` extension function)
   * so the call site inside `ok(id) { ... }`'s `JSONObject.() -> Unit` lambda is unambiguous.
   */
  private fun putOrNull(obj: JSONObject, key: String, value: Int?) {
    obj.put(key, value ?: JSONObject.NULL)
  }

  private fun putOrNull(obj: JSONObject, key: String, value: String?) {
    obj.put(key, value ?: JSONObject.NULL)
  }

  companion object {
    private const val TAG = "EnkakuGuestAgent"
    private const val CHANNEL_ID = "enkaku-control"
    private const val NOTIFICATION_ID = 1
    const val EXTRA_TOKEN = "token"

    /** Slack added on top of a probe's own `timeoutMs` when bounding `RouteVpnService.submitProbe`'s wait — enough for both legs' own internal budgets plus dispatch overhead, without waiting forever on a stuck `ops` executor. */
    private const val PROBE_BUDGET_SLACK_MS = 5_000L

    fun start(context: Context, token: String?) {
      val intent = Intent(context, ControlService::class.java).putExtra(EXTRA_TOKEN, token)
      context.startForegroundService(intent)
    }
  }
}
