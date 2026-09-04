package dev.enkaku.guestagent

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.text.format.Formatter
import android.util.TypedValue
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import dev.enkaku.guestagent.activity.ActivityMirror
import dev.enkaku.guestagent.control.ControlChannelState
import dev.enkaku.guestagent.control.HostExpectation
import dev.enkaku.guestagent.control.Pairing
import dev.enkaku.guestagent.control.Protocol
import dev.enkaku.guestagent.identity.MockLocationState
import dev.enkaku.guestagent.input.ImePrefs
import dev.enkaku.guestagent.input.TextFacet
import dev.enkaku.guestagent.label.WallpaperFacet
import dev.enkaku.guestagent.route.DeadMansSwitch
import dev.enkaku.guestagent.route.EgressProbe
import dev.enkaku.guestagent.route.Ipv6Leak
import dev.enkaku.guestagent.route.RouteLifecycleState
import dev.enkaku.guestagent.route.RouteState
import dev.enkaku.guestagent.route.RouteVpnService
import dev.enkaku.guestagent.route.VpnLink
import dev.enkaku.guestagent.ui.UiTreeService
import dev.enkaku.guestagent.ui.UiTreeState
import dev.enkaku.guestagent.ui.UiTreeWatch
import java.net.URI
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import org.json.JSONObject

/**
 * The only screen a human ever sees, reached by tapping the launcher icon.
 *
 * It is deliberately separate from [BootstrapActivity]. Both jobs used to live in one activity, so
 * every machine-driven bootstrap — which the host does on provisioning and lazily on reconnect —
 * flashed a window in front of whoever was remotely driving the device. Splitting them means the
 * shim can be invisible (`Theme.NoDisplay`) while this stays a normal, visible screen.
 *
 * **What it is for.** It used to draw three fixed lines ("Routing this device's traffic through a
 * test proxy") and nothing else, while the process around it already knew everything an operator
 * actually needs. The incident that changed that: a farm core restarted, the operator switched the
 * route off in Studio, the row read `engine: none, enabled: false` — and the teardown never reached
 * the phone. [RouteVpnService] was still up with no working tunnel and, because the route was
 * `failClosed`, the device blocked all of its own traffic. Diagnosing it took `adb shell dumpsys`,
 * `ip link` and a `ping`, and every one of those answers was already in this process:
 * [RouteState.current] said `HELD`, [RouteState.lastError] said why, and
 * [VpnLink.observe] would have shown the interface Android still had established. The standard for
 * this screen is that question — *what is wrong with this phone* — answered without adb.
 *
 * **What it must never do is overstate.** A route that is `UP` means a tunnel is established, not
 * that traffic reaches the intended exit; the farm's own `deriveHealth` keeps such a device
 * `unverified` until an egress check passes, and the phone must not claim more than the farm does.
 * Where a fact cannot be verified, the row says "not checked" and never "ok" — and where the app
 * holds no fact at all, [buildReport] omits the row rather than rendering an empty one.
 *
 * **No secrets.** A SOCKS5 upstream carries a username and password and the control channel carries
 * a pairing token; neither appears here. [RouteState.describeUpstream] is host and port by
 * construction, and nothing on this screen reads [RouteVpnService.currentUpstream], which is the
 * one accessor that does hold credentials.
 *
 * Still a plain [Activity] with a hand-written layout (`res/layout/activity_status.xml`), and still
 * no Compose: that dependency graph was 21.3 MB of a 21.7 MB release APK when this screen drew
 * three lines of text (plan 90 §3.11, F1/F3), and it would cost exactly the same for the list of
 * label/value rows it draws now — which is the one shape a `TextView` is already good at. Rows are
 * built in code rather than declared in XML for the honesty rule above: a row that has nothing to
 * say is never added.
 */
class StatusActivity : Activity() {

  /** Meaning, not decoration — see `res/values/colors.xml`. [Tone.GOOD] is never used for something this app has not verified. */
  private enum class Tone { NORMAL, MUTED, GOOD, WARN, BAD }

  private data class Row(val label: String, val value: String, val tone: Tone = Tone.NORMAL)

  private data class Section(val title: String, val rows: List<Row>)

  private data class Banner(val title: String, val body: String, val tone: Tone)

  private data class Report(val subtitle: String, val banner: Banner, val sections: List<Section>, val takenAt: Date)

  private val handler = Handler(Looper.getMainLooper())

  /** The state this screen reports changes underneath it — a held route, a farm that comes back — so it re-reads on a timer rather than only on open. */
  private val tick =
    object : Runnable {
      override fun run() {
        refresh()
        handler.postDelayed(this, REFRESH_INTERVAL_MS)
      }
    }

  /** The last report rendered, kept so **Copy** hands over exactly what is on the screen rather than a second, freshly-read one that may differ. */
  private var lastReport: Report? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_status)

    findViewById<Button>(R.id.refresh_button).setOnClickListener { refresh() }
    findViewById<Button>(R.id.copy_button).setOnClickListener { onCopyClicked() }
    findViewById<Button>(R.id.switch_keyboard_button).setOnClickListener { onSwitchKeyboardClicked() }
    findViewById<Button>(R.id.accessibility_button).setOnClickListener { onAccessibilitySettingsClicked() }
  }

  override fun onResume() {
    super.onResume()
    handler.removeCallbacks(tick)
    tick.run()
  }

  override fun onPause() {
    handler.removeCallbacks(tick)
    super.onPause()
  }

  private fun refresh() {
    val report = buildReport()
    lastReport = report
    render(report)
  }

  // ---------------------------------------------------------------------------------------------
  // Reading the facts
  // ---------------------------------------------------------------------------------------------

  private fun buildReport(): Report {
    val paired = Pairing.hasToken()
    val listening = ControlChannelState.isListening()
    val routeState = RouteState.current()
    val vpn = VpnLink.observe(this)

    return Report(
      subtitle = subtitle(),
      banner = banner(paired, listening, routeState, vpn),
      sections =
        listOf(
          nowSection(),
          deviceSection(),
          linkSection(paired, listening),
          videoSection(),
          inspectorSection(),
          routeSection(routeState, vpn),
          checksSection(),
          keyboardSection(),
          labelSection(),
          locationSection(),
          buildSection(),
        ),
      takenAt = Date(),
    )
  }

  /**
   * The one line that has to be readable from across the room, and the reason this screen exists.
   *
   * Order is by how much the state is costing the device right now, not by how interesting it is:
   * a held route is blocking every packet on the phone; a tunnel Android still has established
   * after this agent gave up on it is the same failure one step earlier (and is the exact shape of
   * the incident in this class's own doc comment); a foreign VPN means the farm cannot route this
   * device at all; a dead control channel means nothing the host sends will arrive.
   */
  private fun banner(paired: Boolean, listening: Boolean, routeState: RouteLifecycleState, vpn: VpnLink.Observation?): Banner {
    val interfaceName = vpn?.interfaceName ?: getString(R.string.value_interface_unnamed)
    return when {
      routeState == RouteLifecycleState.HELD ->
        Banner(getString(R.string.banner_held_title), getString(R.string.banner_held_body), Tone.BAD)
      routeState == RouteLifecycleState.DOWN && vpn != null && VpnLink.isOurs(vpn) ->
        Banner(
          getString(R.string.banner_stale_tunnel_title),
          getString(R.string.banner_stale_tunnel_body, interfaceName),
          Tone.BAD,
        )
      vpn != null && !VpnLink.isOurs(vpn) ->
        Banner(
          getString(R.string.banner_foreign_vpn_title),
          getString(R.string.banner_foreign_vpn_body, interfaceName),
          Tone.WARN,
        )
      !listening ->
        Banner(getString(R.string.banner_channel_down_title), getString(R.string.banner_channel_down_body), Tone.WARN)
      routeState == RouteLifecycleState.UP ->
        Banner(getString(R.string.banner_up_title), getString(R.string.banner_up_body), Tone.GOOD)
      // MVP 10 §2's banner — a running job or a controlling actor is not a verified good state
      // (only an egress check earns Tone.GOOD), so this arm is always MUTED. Falls back to the
      // existing "idle" wording when the farm has pushed no activity at all.
      paired -> {
        val activities = ActivityMirror.activities()
        val running = activities.firstOrNull { it.kind != "control" }
        val controller = activities.firstOrNull { it.kind == "control" }
        when {
          running != null -> Banner(getString(R.string.banner_activity_title), getString(R.string.banner_activity_body, running.label), Tone.MUTED)
          controller != null -> Banner(getString(R.string.banner_controlled_title, controller.actorLabel), getString(R.string.banner_controlled_body), Tone.MUTED)
          else -> Banner(getString(R.string.banner_idle_title), getString(R.string.banner_idle_body), Tone.MUTED)
        }
      }
      else -> Banner(getString(R.string.banner_unpaired_title), getString(R.string.banner_unpaired_body), Tone.MUTED)
    }
  }

  /**
   * [ActivityMirror] — what the farm says is happening on this device right now (plan 221 §4.5,
   * MVP 10 §1.3). Read-only: this app never acts on any of it.
   */
  private fun nowSection(): Section {
    val rows = mutableListOf<Row>()
    if (ActivityMirror.updatedAt() == ActivityMirror.NEVER) {
      rows += Row(getString(R.string.label_now_status), getString(R.string.value_now_never), Tone.MUTED)
      return Section(getString(R.string.section_now), rows)
    }
    if (ActivityMirror.isStale()) {
      rows +=
        Row(
          getString(R.string.label_now_status),
          getString(R.string.value_now_stale, since(ControlChannelState.lastRequestAt())),
          Tone.WARN,
        )
    }
    for (activity in ActivityMirror.activities()) {
      rows +=
        Row(
          activity.kind,
          getString(R.string.value_now_activity, activity.label, wallDuration(activity.startedAt), activity.actorLabel),
          Tone.NORMAL,
        )
    }
    return Section(getString(R.string.section_now), rows)
  }

  /**
   * The farm's own facts about this device ([ActivityMirror.device], pushed by `device.describe`)
   * followed by what this app reads about itself directly (model, Android version, battery,
   * screen). `group`, never "cluster" (plan 200 §2.4).
   */
  private fun deviceSection(): Section {
    val rows = mutableListOf<Row>()
    val device = ActivityMirror.device()
    device?.label?.let { label ->
      val value = device.number?.let { "$label · $it" } ?: label
      rows += Row(getString(R.string.label_farm_label), value, Tone.NORMAL)
    }
    device?.group?.let { rows += Row(getString(R.string.label_group), it, Tone.MUTED) }
    if (device != null && device.tags.isNotEmpty()) {
      rows += Row(getString(R.string.label_tags), device.tags.joinToString(", "), Tone.MUTED)
    }
    device?.stableId?.let { rows += Row(getString(R.string.label_stable_id), it, Tone.MUTED) }
    rows += Row(getString(R.string.label_model), "${Build.MANUFACTURER} ${Build.MODEL}", Tone.MUTED)
    rows += Row(getString(R.string.label_android), getString(R.string.value_android, Build.VERSION.RELEASE, Build.VERSION.SDK_INT), Tone.MUTED)
    batteryRow()?.let { rows += it }
    rows += screenRow()
    return Section(getString(R.string.section_device), rows)
  }

  private fun batteryRow(): Row? {
    val bm = getSystemService(BatteryManager::class.java) ?: return null
    val pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    if (pct < 0) return null
    val charging = bm.isCharging
    val value =
      if (charging) getString(R.string.value_battery_charging, pct) else getString(R.string.value_battery_on_battery, pct)
    return Row(getString(R.string.label_battery), value, Tone.MUTED)
  }

  private fun screenRow(): Row {
    val on = getSystemService(PowerManager::class.java)?.isInteractive == true
    return Row(getString(R.string.label_screen), if (on) getString(R.string.value_screen_on) else getString(R.string.value_screen_off), Tone.MUTED)
  }

  /**
   * What the farm STARTED, per [ActivityMirror.video] — never a claim that anyone is watching
   * (MVP 10 §2). The whole section is omitted only when the farm has never pushed anything at
   * all; once it has, "no scrcpy server running" is itself a fact, not a blank.
   */
  private fun videoSection(): Section {
    if (ActivityMirror.updatedAt() == ActivityMirror.NEVER) return Section(getString(R.string.section_video), emptyList())
    val video = ActivityMirror.video()
    val rows = mutableListOf<Row>()
    rows +=
      if (video != null && video.running) {
        Row(getString(R.string.label_video), getString(R.string.value_video_running, video.widthPx, video.heightPx, video.fps), Tone.NORMAL)
      } else {
        Row(getString(R.string.label_video), getString(R.string.value_video_none), Tone.MUTED)
      }
    rows += Row(getString(R.string.label_video_note), getString(R.string.value_video_note), Tone.MUTED)
    return Section(getString(R.string.section_video), rows)
  }

  /** [UiTreeState] and the Settings fact — see `UiStatusResultSchema`'s doc comment for why `enabled` and `connected` are separate. */
  private fun inspectorSection(): Section {
    val rows = mutableListOf<Row>()
    val enabledList = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
    val enabled = enabledList?.contains(UiTreeService.COMPONENT_ID) == true
    val connected = UiTreeState.isConnected()
    rows +=
      when {
        enabled && connected -> Row(getString(R.string.label_inspector_service), getString(R.string.value_inspector_enabled_connected), Tone.GOOD)
        enabled -> Row(getString(R.string.label_inspector_service), getString(R.string.value_inspector_enabled_not_connected), Tone.WARN)
        else -> Row(getString(R.string.label_inspector_service), getString(R.string.value_inspector_not_enabled), Tone.MUTED)
      }
    rows +=
      Row(
        getString(R.string.label_inspector_watching),
        if (UiTreeWatch.isWatching()) getString(R.string.value_inspector_watching_yes) else getString(R.string.value_inspector_watching_idle),
        Tone.MUTED,
      )
    if (UiTreeState.lastDumpAt() != UiTreeState.NEVER) {
      rows +=
        Row(
          getString(R.string.label_inspector_last_dump),
          getString(R.string.value_inspector_last_dump, UiTreeState.lastDumpNodes(), UiTreeState.lastDumpTookMs(), since(UiTreeState.lastDumpAt())),
          Tone.MUTED,
        )
    }
    UiTreeState.lastError()?.let { rows += Row(getString(R.string.label_inspector_last_error), it, Tone.WARN) }
    return Section(getString(R.string.section_inspector), rows)
  }

  /** [WallpaperFacet.status] — "Applied" is omitted, never rendered "no", when this app has never applied a label (`fingerprint == null`). */
  private fun labelSection(): Section {
    val status = WallpaperFacet.status(this)
    val rows = mutableListOf<Row>()
    if (status.fingerprint != null) {
      rows +=
        Row(
          getString(R.string.label_label_applied),
          getString(R.string.value_label_applied_yes),
          if (status.matchesOurs) Tone.GOOD else Tone.WARN,
        )
    }
    rows += Row(getString(R.string.label_label_renderer), status.rendererVersion.toString(), Tone.MUTED)
    return Section(getString(R.string.section_label), rows)
  }

  /** [MockLocationState] — [dev.enkaku.guestagent.identity.MockLocation] itself is stateless by design and remembers no fix. */
  private fun locationSection(): Section {
    val rows = mutableListOf<Row>()
    rows +=
      Row(
        getString(R.string.label_location_mock),
        if (MockLocationState.isActive()) getString(R.string.value_location_active) else getString(R.string.value_location_inactive),
        Tone.MUTED,
      )
    MockLocationState.lastFix()?.let { (lat, lng) ->
      rows +=
        Row(
          getString(R.string.label_location_last_fix),
          getString(R.string.value_location_last_fix, round3(lat), round3(lng), since(MockLocationState.setAt())),
          Tone.MUTED,
        )
    }
    return Section(getString(R.string.section_location), rows)
  }

  /** [Pairing] and [ControlChannelState] — is a farm host there, and when did it last say anything? */
  private fun linkSection(paired: Boolean, listening: Boolean): Section {
    val rows = mutableListOf<Row>()

    rows +=
      if (paired) {
        Row(getString(R.string.label_paired), getString(R.string.value_paired_yes, since(Pairing.pairedAt())), Tone.GOOD)
      } else {
        Row(getString(R.string.label_paired), getString(R.string.value_paired_no), Tone.MUTED)
      }

    val listenError = ControlChannelState.listenError()
    rows +=
      when {
        listening ->
          Row(getString(R.string.label_channel), getString(R.string.value_channel_listening, Protocol.SOCKET_NAME), Tone.GOOD)
        listenError != null ->
          Row(getString(R.string.label_channel), getString(R.string.value_channel_failed, listenError), Tone.BAD)
        else -> Row(getString(R.string.label_channel), getString(R.string.value_channel_stopped), Tone.WARN)
      }

    if (listening && ControlChannelState.startedAt() != ControlChannelState.NEVER) {
      rows += Row(getString(R.string.label_channel_uptime), since(ControlChannelState.startedAt()), Tone.MUTED)
    }

    val lastRequestAt = ControlChannelState.lastRequestAt()
    rows +=
      if (lastRequestAt == ControlChannelState.NEVER) {
        Row(getString(R.string.label_last_contact), getString(R.string.value_last_contact_never), Tone.MUTED)
      } else {
        Row(
          getString(R.string.label_last_contact),
          getString(R.string.value_last_contact, since(lastRequestAt), ControlChannelState.lastMethod().orEmpty()),
          // Only the dead-man's switch decides what "too long" means, and only while a route is up
          // (see `DeadMansSwitch.check`) — so silence is flagged here on exactly that condition and
          // never dressed up as a problem when there is no route to strand.
          if (RouteState.isUp() && elapsed(lastRequestAt) > DeadMansSwitch.DEFAULT_TIMEOUT_MS) Tone.WARN else Tone.NORMAL,
        )
      }

    val requests = ControlChannelState.requestCount()
    if (requests > 0) {
      rows += Row(getString(R.string.label_requests), count(requests.toLong()), Tone.MUTED)
    }

    val refusedCode = ControlChannelState.lastRejectionCode()
    if (refusedCode != null) {
      rows +=
        Row(
          getString(R.string.label_last_refused),
          getString(R.string.value_last_refused, refusedCode, since(ControlChannelState.lastRejectionAt())),
          Tone.WARN,
        )
    }

    return Section(getString(R.string.section_link), rows)
  }

  /**
   * [RouteState] — what this agent believes — followed by [VpnLink], which is what Android
   * actually has. Both are shown because the interesting failures are the ones where they disagree.
   */
  private fun routeSection(routeState: RouteLifecycleState, vpn: VpnLink.Observation?): Section {
    val rows = mutableListOf<Row>()

    rows +=
      when (routeState) {
        RouteLifecycleState.UP -> Row(getString(R.string.label_state), getString(R.string.value_state_up), Tone.GOOD)
        RouteLifecycleState.HELD -> Row(getString(R.string.label_state), getString(R.string.value_state_held), Tone.BAD)
        RouteLifecycleState.DOWN -> Row(getString(R.string.label_state), getString(R.string.value_state_down), Tone.MUTED)
      }

    // Host and port only, by construction: `RouteState.markUp` is handed `"${host}:${port}"` and
    // the credentials never leave `RouteVpnService.currentUpstreamRef`, which nothing here reads.
    val upstream = RouteState.describeUpstream()
    rows +=
      Row(
        getString(R.string.label_upstream),
        upstream ?: getString(R.string.value_upstream_none),
        if (upstream == null) Tone.MUTED else Tone.NORMAL,
      )

    // Only meaningful while a route exists to have a policy: `RouteVpnService.failClosed()`
    // deliberately answers `true` when there is no active route to ask, which would read as a
    // claim about a route that is not there.
    if (routeState != RouteLifecycleState.DOWN) {
      val failClosed = RouteVpnService.failClosed()
      rows +=
        Row(
          getString(R.string.label_fail_closed),
          if (failClosed) getString(R.string.value_fail_closed_on) else getString(R.string.value_fail_closed_off),
          Tone.MUTED,
        )
    }

    // Verbatim. Whatever the route last recorded is what an operator has to match against a log.
    RouteState.lastError()?.let {
      rows += Row(getString(R.string.label_last_error), it, if (routeState == RouteLifecycleState.UP) Tone.MUTED else Tone.BAD)
    }

    // `[txPackets, txBytes, rxPackets, rxBytes]` — see `Tun2Socks.TProxyGetStats`. Present only
    // while the route is UP: `RouteState` drops the provider on hold and on teardown, so there is
    // deliberately nothing to show for a held route rather than a frozen last-known number.
    val stats = RouteState.stats()
    if (stats != null && stats.size >= 4) {
      rows += Row(getString(R.string.label_sent), traffic(stats[1], stats[0]), Tone.MUTED)
      rows += Row(getString(R.string.label_received), traffic(stats[3], stats[2]), Tone.MUTED)
    }

    val prepared = RouteVpnService.isPrepared(this)
    rows +=
      Row(
        getString(R.string.label_consent),
        if (prepared) getString(R.string.value_consent_granted) else getString(R.string.value_consent_missing),
        if (prepared) Tone.MUTED else Tone.WARN,
      )

    if (vpn == null) {
      rows += Row(getString(R.string.label_os_view), getString(R.string.value_os_vpn_none), Tone.MUTED)
    } else {
      val name = vpn.interfaceName ?: getString(R.string.value_interface_unnamed)
      val ours = VpnLink.isOurs(vpn)
      rows +=
        Row(
          getString(R.string.label_os_view),
          if (ours) getString(R.string.value_os_vpn_ours, name) else getString(R.string.value_os_vpn_foreign, name),
          if (ours) Tone.NORMAL else Tone.WARN,
        )
      rows +=
        Row(
          getString(R.string.label_os_capture),
          if (vpn.hasIpv4Default) getString(R.string.value_os_capture_all) else getString(R.string.value_os_capture_none),
          Tone.MUTED,
        )
      vpn.validated?.let {
        rows +=
          Row(
            getString(R.string.label_os_validated),
            if (it) getString(R.string.value_os_validated_yes) else getString(R.string.value_os_validated_no),
            Tone.MUTED,
          )
      }
    }

    return Section(getString(R.string.section_route), rows)
  }

  /** The three things that are asserted rather than assumed: [Ipv6Leak], [DeadMansSwitch]'s budget, and whatever egress has actually been measured. */
  private fun checksSection(): Section {
    val rows = mutableListOf<Row>()

    // Tri-state on purpose (see `Ipv6Leak.isBlocked`): null is "no VPN network to ask", which is
    // not the same claim as "no leak" and must not be rendered as one.
    when (Ipv6Leak.isBlocked(this)) {
      true -> rows += Row(getString(R.string.label_ipv6), getString(R.string.value_ipv6_blocked), Tone.MUTED)
      false -> rows += Row(getString(R.string.label_ipv6), getString(R.string.value_ipv6_open), Tone.BAD)
      null -> rows += Row(getString(R.string.label_ipv6), getString(R.string.value_ipv6_unknown), Tone.MUTED)
    }

    rows +=
      Row(
        getString(R.string.label_deadman),
        getString(R.string.value_deadman, duration(DeadMansSwitch.DEFAULT_TIMEOUT_MS)),
        Tone.MUTED,
      )

    // This app never starts a probe of its own — it has no probe URL to start one against — so the
    // honest answer before the farm has run one is "not checked", never a hopeful blank.
    val probe = EgressProbe.lastRun()
    if (probe == null) {
      rows += Row(getString(R.string.label_egress), getString(R.string.value_egress_unchecked), Tone.WARN)
    } else {
      rows +=
        Row(
          getString(R.string.label_egress),
          getString(R.string.value_egress_ran, since(probe.atElapsedRealtime), probeTarget(probe.url)),
          Tone.NORMAL,
        )
      rows += legRow(R.string.label_egress_tunnelled, probe.result.tunnelled)
      rows += legRow(R.string.label_egress_direct, probe.result.direct)
    }

    return Section(getString(R.string.section_checks), rows)
  }

  /** [TextFacet] — the facet the button at the bottom of this screen switches to. */
  private fun keyboardSection(): Section {
    val status = TextFacet.status(this)
    val rows = mutableListOf<Row>()
    rows +=
      when (status.ime) {
        "current" -> Row(getString(R.string.label_ime), getString(R.string.value_ime_current), Tone.GOOD)
        "enabled" -> Row(getString(R.string.label_ime), getString(R.string.value_ime_enabled), Tone.MUTED)
        else -> Row(getString(R.string.label_ime), getString(R.string.value_ime_disabled), Tone.MUTED)
      }
    // Only meaningful while this IME is the selected one; otherwise it is always "none focused",
    // which reads like a fault rather than the tautology it is.
    if (status.ime == "current") {
      rows +=
        Row(
          getString(R.string.label_ime_connection),
          if (status.connected) getString(R.string.value_ime_connected) else getString(R.string.value_ime_disconnected),
          Tone.MUTED,
        )
      // Plan 221 §4.6, MVP 08 §1.2 — only meaningful while this IME is actually the live one;
      // otherwise there is no keyboard state on this device to report at all.
      rows +=
        Row(
          getString(R.string.label_soft_keyboard),
          if (status.softKeyboardShown) getString(R.string.value_soft_keyboard_showing) else getString(R.string.value_soft_keyboard_hidden),
          Tone.MUTED,
        )
      rows +=
        Row(
          getString(R.string.label_soft_keyboard_with_hardware),
          if (status.showSoftKeyboardWithHardware) {
            getString(R.string.value_soft_keyboard_with_hardware_on)
          } else {
            getString(R.string.value_soft_keyboard_with_hardware_off)
          },
          Tone.MUTED,
        )
    }
    return Section(getString(R.string.section_keyboard), rows)
  }

  /** Enough to tell an outdated agent from a misbehaving one — the same facts `hello` reports to the host. */
  private fun buildSection(): Section {
    val rows =
      mutableListOf(
        Row(getString(R.string.label_version), versionLabel(), Tone.NORMAL),
        Row(getString(R.string.label_protocol), Protocol.PROTOCOL_VERSION.toString(), Tone.MUTED),
        Row(getString(R.string.label_capabilities), Protocol.CAPABILITIES.joinToString(", "), Tone.MUTED),
        Row(getString(R.string.label_android), getString(R.string.value_android, Build.VERSION.RELEASE, Build.VERSION.SDK_INT), Tone.MUTED),
        Row(getString(R.string.label_device), "${Build.MANUFACTURER} ${Build.MODEL}", Tone.MUTED),
        Row(getString(R.string.label_package), packageName, Tone.MUTED),
      )
    // Plan 221 §4.9 — the host's own pin, told to us on `hello`. Omitted unless it names a build
    // strictly newer than the one answering right now: an equal or lower number is not news.
    val expected = HostExpectation.versionCode()
    val ours = runCatching { packageManager.getPackageInfo(packageName, 0).longVersionCode }.getOrNull() ?: 0L
    if (expected > 0 && expected > ours) {
      rows += Row(getString(R.string.label_host_expects), getString(R.string.value_host_expects, expected), Tone.WARN)
    }
    return Section(getString(R.string.section_build), rows)
  }

  // ---------------------------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------------------------

  private fun render(report: Report) {
    findViewById<TextView>(R.id.subtitle).text = report.subtitle

    findViewById<LinearLayout>(R.id.banner).setBackgroundColor(getColor(bannerBackground(report.banner.tone)))
    findViewById<TextView>(R.id.banner_title).apply {
      text = report.banner.title
      setTextColor(getColor(foreground(report.banner.tone)))
    }
    findViewById<TextView>(R.id.banner_body).text = report.banner.body

    val container = findViewById<LinearLayout>(R.id.sections)
    container.removeAllViews()
    for (section in report.sections) {
      if (section.rows.isEmpty()) continue
      container.addView(sectionHeader(section.title))
      for (row in section.rows) container.addView(rowView(row))
    }

    findViewById<TextView>(R.id.footer).text = getString(R.string.status_updated, CLOCK.format(report.takenAt))
  }

  private fun sectionHeader(title: String): View =
    TextView(this).apply {
      text = title
      setAllCaps(true)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
      setTextColor(getColor(R.color.status_fg_muted))
      setPadding(0, dp(18), 0, dp(4))
    }

  private fun rowView(row: Row): View {
    val label =
      TextView(this).apply {
        text = row.label
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        setTextColor(getColor(R.color.status_fg_muted))
        layoutParams = LinearLayout.LayoutParams(dp(LABEL_WIDTH_DP), LinearLayout.LayoutParams.WRAP_CONTENT)
      }
    val value =
      TextView(this).apply {
        text = row.value
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        setTextColor(getColor(foreground(row.tone)))
        // Weighted rather than wrap_content: a `lastError` is arbitrary text from a native tunnel
        // and has to wrap inside the screen instead of running off the right edge.
        layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
      }
    return LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      setPadding(0, dp(3), 0, dp(3))
      addView(label)
      addView(value)
    }
  }

  private fun foreground(tone: Tone): Int =
    when (tone) {
      Tone.NORMAL -> R.color.status_fg
      Tone.MUTED -> R.color.status_fg_muted
      Tone.GOOD -> R.color.status_good
      Tone.WARN -> R.color.status_warn
      Tone.BAD -> R.color.status_bad
    }

  private fun bannerBackground(tone: Tone): Int =
    when (tone) {
      Tone.BAD -> R.color.banner_bad_bg
      Tone.WARN -> R.color.banner_warn_bg
      Tone.GOOD -> R.color.banner_good_bg
      else -> R.color.banner_muted_bg
    }

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

  // ---------------------------------------------------------------------------------------------
  // Buttons
  // ---------------------------------------------------------------------------------------------

  /**
   * Puts the report on the clipboard as plain text. Whoever is debugging this device is about to
   * paste it into a message, and retyping "no contact from the farm for 91004ms" off a phone screen
   * is how the one detail that mattered gets dropped.
   */
  private fun onCopyClicked() {
    val report = lastReport ?: buildReport().also { lastReport = it }
    val clipboard = getSystemService(ClipboardManager::class.java) ?: return
    clipboard.setPrimaryClip(ClipData.newPlainText(getString(R.string.app_name), asText(report)))
    Toast.makeText(this, R.string.report_copied, Toast.LENGTH_SHORT).show()
  }

  /**
   * Opens the system keyboard picker so a human physically holding the phone can switch to the
   * Enkaku keyboard — but only when it is actually there to switch to. On a build where the host
   * has not yet run `ime enable` for it, this must say so rather than opening a picker with nothing
   * useful in it or throwing. A dead button with no explanation is exactly the half-feature plan 90
   * §3.2 exists to avoid.
   */
  private fun onSwitchKeyboardClicked() {
    val imm = getSystemService(InputMethodManager::class.java)
    val available = imm?.enabledInputMethodList?.any { it.id == ENKAKU_IME_ID } == true
    if (available) {
      imm?.showInputMethodPicker()
    } else {
      Toast.makeText(this, R.string.keyboard_not_available, Toast.LENGTH_LONG).show()
    }
  }

  /**
   * The last resort of R4's OEM caveat (plan 221 §4.10): on a build where the host could not
   * write `enabled_accessibility_services` from adb, a human holding the phone enables it here.
   * Never a silent no-op — a device with no such screen says so, the same way the keyboard button
   * already does.
   */
  private fun onAccessibilitySettingsClicked() {
    val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    if (intent.resolveActivity(packageManager) != null) {
      startActivity(intent)
    } else {
      Toast.makeText(this, R.string.accessibility_settings_missing, Toast.LENGTH_LONG).show()
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------------------------

  private fun asText(report: Report): String = buildString {
    appendLine(getString(R.string.app_name))
    appendLine(report.subtitle)
    appendLine()
    appendLine("[${report.banner.title}]")
    appendLine(report.banner.body)
    for (section in report.sections) {
      if (section.rows.isEmpty()) continue
      appendLine()
      appendLine("${section.title}:")
      for (row in section.rows) appendLine("  ${row.label}: ${row.value}")
    }
    appendLine()
    appendLine(getString(R.string.status_updated, CLOCK.format(report.takenAt)))
  }

  private fun subtitle(): String = "${versionLabel()} · $packageName"

  private fun versionLabel(): String {
    // `buildConfig = false` in `app/build.gradle.kts`, so there is no `BuildConfig` to read — the
    // PackageManager holds the same two values the release workflow derived from the `v*` tag.
    val info = runCatching { packageManager.getPackageInfo(packageName, 0) }.getOrNull()
    return getString(R.string.value_version, info?.versionName ?: "unknown", info?.longVersionCode ?: 0L)
  }

  /** Elapsed since a [SystemClock.elapsedRealtime] stamp — the only clock any timestamp on this screen is recorded against. */
  private fun elapsed(atElapsedRealtime: Long): Long = SystemClock.elapsedRealtime() - atElapsedRealtime

  private fun since(atElapsedRealtime: Long): String = duration(elapsed(atElapsedRealtime))

  private fun duration(ms: Long): String {
    val seconds = (ms / 1000).coerceAtLeast(0)
    return when {
      seconds < 60 -> getString(R.string.duration_seconds, seconds)
      seconds < 3600 -> getString(R.string.duration_minutes, seconds / 60, seconds % 60)
      else -> getString(R.string.duration_hours, seconds / 3600, (seconds % 3600) / 60)
    }
  }

  /** Grouped in the DEVICE's locale, matching `Formatter.formatShortFileSize` beside it — mixing `1,204` with `3,9 MB` on one row reads as a typo. */
  private fun count(value: Long): String = String.format(Locale.getDefault(), "%,d", value)

  /**
   * Elapsed since a HOST-supplied unix-seconds timestamp (`ActivityMirror.Activity.startedAt`) —
   * the one duration on this screen measured against the wall clock rather than
   * [SystemClock.elapsedRealtime], because the host never sends us its own elapsed-realtime clock.
   */
  private fun wallDuration(unixSeconds: Long): String = duration((System.currentTimeMillis() / 1000 - unixSeconds) * 1000)

  /** Three decimal places — enough to place a device without being precise about it, matching `location.set`'s own accuracy story. */
  private fun round3(value: Double): String = String.format(Locale.US, "%.3f", value)

  private fun traffic(bytes: Long, packets: Long): String =
    getString(R.string.value_traffic, Formatter.formatShortFileSize(this, bytes), count(packets))

  private fun legRow(labelRes: Int, leg: EgressProbe.Leg): Row =
    if (leg.ok) {
      Row(getString(labelRes), getString(R.string.value_leg_ok, leg.status ?: 0, leg.ms, seenAs(leg)), Tone.GOOD)
    } else {
      Row(
        getString(labelRes),
        getString(R.string.value_leg_failed, leg.stage ?: "connect", leg.error ?: "unknown", leg.ms),
        Tone.BAD,
      )
    }

  /**
   * The address `packages/probe-server` reports having seen the request come from, when the body
   * happens to be its JSON. Best-effort and silent on anything else: the host can point a probe at
   * any URL it likes, and a body this app cannot parse is not a failure to report — it is simply a
   * fact this screen does not have. Comparing the two legs' addresses is what tells an operator the
   * tunnel is carrying traffic somewhere other than the device's own exit.
   */
  private fun seenAs(leg: EgressProbe.Leg): String {
    val body = leg.body ?: return ""
    val address = runCatching { JSONObject(body).optString("address").takeIf { it.isNotEmpty() } }.getOrNull() ?: return ""
    return getString(R.string.value_leg_seen_as, address)
  }

  /** Scheme, host and path of the probe URL — the query is dropped, since only the host chooses what goes in it. */
  private fun probeTarget(url: String): String =
    runCatching {
      val uri = URI(url)
      buildString {
        append(uri.scheme).append("://").append(uri.host)
        if (uri.port != -1) append(":").append(uri.port)
        append(uri.rawPath.orEmpty())
      }
    }
      .getOrNull() ?: url.substringBefore('?')

  companion object {
    /** [android.view.inputmethod.InputMethodInfo.getId] — matches `text.status`'s documented `id` (plan 90 §4.1). */
    private const val ENKAKU_IME_ID = "dev.enkaku.guestagent/.input.EnkakuIme"

    /** Fast enough that a route dropping under the reader's eyes is visible, slow enough to be free. */
    private const val REFRESH_INTERVAL_MS = 2_000L

    private const val LABEL_WIDTH_DP = 118

    private val CLOCK = SimpleDateFormat("HH:mm:ss", Locale.US)
  }
}
