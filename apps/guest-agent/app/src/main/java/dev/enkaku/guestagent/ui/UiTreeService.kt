package dev.enkaku.guestagent.ui

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.content.Intent
import android.graphics.Rect
import android.os.Build
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.lang.ref.WeakReference
import org.json.JSONArray
import org.json.JSONObject

/**
 * The first-party inspector (MVP 02 §4 phase 2, MVP 10 §1.1). An [AccessibilityService] reading
 * the same data source UiAutomator reads ([AccessibilityNodeInfo]) and emitting the SAME node
 * shape `packages/protocol/src/ui-node.ts` defines, so selectors, the Zod schema and every
 * consumer carry over unchanged.
 *
 * It passes the APK rule (`apps/guest-agent/README.md`, "the rule that decides what goes in it"):
 * there is no shell equivalent that survives without `am instrument`, which is exactly the
 * instrumentation this replaces.
 *
 * What it must never do is overstate. A tree that hit [MAX_NODES] is reported with
 * `truncated: true` rather than as a complete tree, and a service that is in the build but not
 * enabled in Settings answers `E_UI_TREE_UNAVAILABLE` rather than an empty tree.
 */
class UiTreeService : AccessibilityService() {

  override fun onServiceConnected() {
    serviceInfo =
      AccessibilityServiceInfo().apply {
        eventTypes =
          AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED or
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
            AccessibilityEvent.TYPE_WINDOWS_CHANGED
        feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
        // FLAG_INCLUDE_NOT_IMPORTANT_VIEWS: `uiautomator dump` includes them, so omitting them
        // would make the two trees differ for a reason nothing in the product asked for.
        // FLAG_REPORT_VIEW_IDS: without it `viewIdResourceName` is null and every `{ id }`
        // selector silently stops matching.
        // FLAG_RETRIEVE_INTERACTIVE_WINDOWS: `windows` is empty without it, and the dump would
        // carry only the active window where the dump engine carries all of them.
        flags =
          AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS or
            AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
            AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        // 0, not the platform default: the platform's own coalescing window would add latency on
        // top of UiTreeWatch's own debounce, and one coalescer is enough (§4.4).
        notificationTimeout = 0
      }
    active = WeakReference(this)
    UiTreeState.markConnected()
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    val pkg = event?.packageName?.toString().orEmpty()
    val reason =
      when (event?.eventType) {
        AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> "window"
        AccessibilityEvent.TYPE_WINDOWS_CHANGED -> "windows"
        else -> "content"
      }
    UiTreeState.recordEvent()
    UiTreeWatch.onChanged(pkg, reason)
  }

  override fun onInterrupt() {
    // Nothing to interrupt: this service speaks to no one but the control channel.
  }

  override fun onUnbind(intent: Intent?): Boolean {
    if (active?.get() === this) active = null
    UiTreeState.markDisconnected()
    return super.onUnbind(intent)
  }

  /** `[width, height]` of the default display, for the dump's own `frameSize` (never the video's). */
  private fun frameSize(): Pair<Int, Int> {
    val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
    return if (Build.VERSION.SDK_INT >= 30) {
      val b = wm.currentWindowMetrics.bounds
      b.width() to b.height()
    } else {
      @Suppress("DEPRECATION")
      val size = android.graphics.Point().also { wm.defaultDisplay.getRealSize(it) }
      size.x to size.y
    }
  }

  /**
   * The whole tree, as [UiNodeSchema]-shaped JSON. The synthetic root copies
   * `packages/drivers/src/inspector/xml-parser.ts`'s `parseUiDump` root byte for byte — a
   * `className` of `"hierarchy"`, empty strings, zero bounds, `enabled: true`, `index: 0` — so a
   * consumer cannot tell which engine produced it.
   */
  fun dump(maxDepth: Int = MAX_DEPTH, maxNodes: Int = MAX_NODES): Dump {
    val started = System.nanoTime()
    val counter = Counter(maxNodes)
    val children = JSONArray()
    val roots = windowRoots()
    for ((ordinal, root) in roots.withIndex()) {
      children.put(toJson(root, ordinal, 1, maxDepth, counter))
    }
    val (width, height) = frameSize()
    val root =
      JSONObject().apply {
        put("resourceId", "")
        put("text", "")
        put("desc", "")
        put("className", "hierarchy")
        put("packageName", "")
        put("bounds", boundsJson(0, 0, 0, 0))
        put("clickable", false)
        put("enabled", true)
        put("focused", false)
        put("index", 0)
        put("children", children)
      }
    val tookMs = ((System.nanoTime() - started) / 1_000_000L).toInt()
    UiTreeState.recordDump(counter.used, tookMs)
    return Dump(root, width, height, counter.used, counter.truncated, tookMs)
  }

  /**
   * Depth-first, first match, reproducing `packages/protocol/src/selector-match.ts`'s `matches()`
   * EXACTLY: `{ id }` is equality or a `:id/<short>` suffix, `{ desc }` and `{ text }` are
   * trimmed equality. `{ point }` never reaches here — `ControlService` refuses it with
   * `E_BAD_REQUEST`, because it is a host-side synthetic node with nothing on the device to look
   * up.
   */
  fun find(kind: String, value: String, maxDepth: Int = MAX_DEPTH, maxNodes: Int = MAX_NODES): Found {
    val started = System.nanoTime()
    val counter = Counter(maxNodes)
    var first: JSONObject? = null
    var count = 0
    for ((ordinal, root) in windowRoots().withIndex()) {
      walk(root, ordinal, 1, maxDepth, maxNodes, counter) { node, json ->
        if (matches(node, kind, value)) {
          count++
          if (first == null) first = json()
        }
      }
    }
    return Found(first, count, ((System.nanoTime() - started) / 1_000_000L).toInt())
  }

  private fun matches(node: AccessibilityNodeInfo, kind: String, value: String): Boolean =
    when (kind) {
      "id" -> {
        val id = node.viewIdResourceName.orEmpty()
        id == value || id.endsWith(":id/$value")
      }
      "desc" -> node.contentDescription?.toString().orEmpty().trim() == value.trim()
      "text" -> node.text?.toString().orEmpty().trim() == value.trim()
      else -> false
    }

  /** Windows bottom to top by layer, each contributing its root; the active window alone when `windows` is empty. */
  private fun windowRoots(): List<AccessibilityNodeInfo> {
    val fromWindows = runCatching { windows.sortedBy { it.layer }.mapNotNull { it.root } }.getOrDefault(emptyList())
    if (fromWindows.isNotEmpty()) return fromWindows
    return listOfNotNull(rootInActiveWindow)
  }

  private fun toJson(node: AccessibilityNodeInfo, index: Int, depth: Int, maxDepth: Int, counter: Counter): JSONObject {
    counter.take()
    val rect = Rect().also { node.getBoundsInScreen(it) }
    val children = JSONArray()
    if (depth < maxDepth) {
      for (i in 0 until node.childCount) {
        if (counter.exhausted()) break
        val child = node.getChild(i) ?: continue
        children.put(toJson(child, i, depth + 1, maxDepth, counter))
        recycleIfNeeded(child)
      }
    } else {
      counter.truncated = true
    }
    return JSONObject().apply {
      put("resourceId", node.viewIdResourceName.orEmpty())
      put("text", node.text?.toString().orEmpty())
      put("desc", node.contentDescription?.toString().orEmpty())
      put("className", node.className?.toString().orEmpty())
      put("packageName", node.packageName?.toString().orEmpty())
      put("bounds", boundsJson(rect.left, rect.top, rect.right, rect.bottom))
      put("clickable", node.isClickable)
      put("enabled", node.isEnabled)
      put("focused", node.isFocused)
      put("index", index)
      put("children", children)
    }
  }

  /**
   * The same traversal as [toJson] with the JSON build made lazy, so a find that matches nothing
   * never serialises a node.
   */
  private fun walk(
    node: AccessibilityNodeInfo,
    index: Int,
    depth: Int,
    maxDepth: Int,
    maxNodes: Int,
    counter: Counter,
    visit: (AccessibilityNodeInfo, () -> JSONObject) -> Unit,
  ) {
    counter.take()
    // A fresh counter bounds the LAZY serialisation of this one matched node's own subtree — it
    // must not share state with the walk's own traversal counter, whose job is bounding how many
    // nodes the SEARCH visits, not how large a single match's JSON is allowed to be.
    visit(node) { toJson(node, index, depth, maxDepth, Counter(maxNodes)) }
    if (depth >= maxDepth) {
      counter.truncated = true
      return
    }
    for (i in 0 until node.childCount) {
      if (counter.exhausted()) break
      val child = node.getChild(i) ?: continue
      walk(child, i, depth + 1, maxDepth, maxNodes, counter, visit)
      recycleIfNeeded(child)
    }
  }

  private fun boundsJson(left: Int, top: Int, right: Int, bottom: Int): JSONObject =
    JSONObject().apply {
      put("left", left)
      put("top", top)
      put("right", right)
      put("bottom", bottom)
    }

  /**
   * `AccessibilityNodeInfo.recycle()` is deprecated from API 33 and is a no-op there, but below 33
   * a node obtained from `getChild` that is never recycled leaks the platform's node pool. minSdk
   * is 29, so both paths are live.
   */
  private fun recycleIfNeeded(node: AccessibilityNodeInfo) {
    if (Build.VERSION.SDK_INT < 33) {
      @Suppress("DEPRECATION")
      runCatching { node.recycle() }
    }
  }

  data class Dump(
    val root: JSONObject,
    val widthPx: Int,
    val heightPx: Int,
    val nodeCount: Int,
    val truncated: Boolean,
    val tookMs: Int,
  )

  data class Found(val node: JSONObject?, val matches: Int, val tookMs: Int)

  /** Bounds the walk so one pathological screen cannot produce a megabyte of JSON on a control socket. */
  class Counter(private val max: Int) {
    var used = 0
      private set
    var truncated = false
    fun take() { used++ }
    fun exhausted(): Boolean {
      if (used >= max) { truncated = true; return true }
      return false
    }
  }

  companion object {
    /** Matches openatx's own `maxDepth` ceiling (R5) — deep enough for every real screen, shallow enough to bound a cycle. */
    const val MAX_DEPTH = 50
    const val MAX_NODES = 5_000

    @Volatile private var active: WeakReference<UiTreeService>? = null

    /** The live service, or `null` when it is not enabled in Settings or not yet connected. */
    fun instance(): UiTreeService? = active?.get()

    /** `AccessibilityServiceInfo.getId()`'s form, the exact string the host writes into `enabled_accessibility_services`. */
    const val COMPONENT_ID = "dev.enkaku.guestagent/dev.enkaku.guestagent.ui.UiTreeService"
  }
}
