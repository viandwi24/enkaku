package dev.enkaku.guestagent.route

/**
 * The Kotlin peer of `hev-socks5-tunnel`'s JNI layer.
 *
 * `src/hev-jni.c` resolves this class by name at `JNI_OnLoad` time —
 * `FindClass(env, PKGNAME "/" CLSNAME)` — with both halves baked in at compile time by the
 * `-DPKGNAME=dev/enkaku/guestagent/route -DCLSNAME=Tun2Socks` flags in `app/build.gradle.kts`.
 * **Renaming or moving this class silently breaks the native library at load time**, with no
 * compile error, so the two must be changed together.
 *
 * Method names and signatures verified against the C source at tag 2.16.0, not against
 * documentation. The upstream registers exactly three methods — there is no `TProxyIsRunning`,
 * despite what some integration guides show.
 */
object Tun2Socks {

  init {
    System.loadLibrary("hev-socks5-tunnel")
  }

  /**
   * Starts forwarding packets between the TUN device and the SOCKS5 upstream.
   *
   * @param configPath path to the YAML config written by [Socks5Config]
   * @param fd the file descriptor from `VpnService.Builder.establish()`. The native side takes
   *   ownership of a duplicate; the caller still closes its own copy on teardown.
   *
   * Blocks until [TProxyStopService] is called, so it must never run on the main thread.
   */
  external fun TProxyStartService(configPath: String, fd: Int)

  /** Stops forwarding and unblocks [TProxyStartService]. Safe to call when already stopped. */
  external fun TProxyStopService()

  /** Byte and packet counters, as `[txPackets, txBytes, rxPackets, rxBytes]`. */
  external fun TProxyGetStats(): LongArray
}
