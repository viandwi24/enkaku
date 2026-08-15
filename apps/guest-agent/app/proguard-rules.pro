# Plan 90 §3.11/§4.8 — this file only exists because isMinifyEnabled is now true (F2 fixed). Every
# rule below is here because ordinary Kotlin-to-bytecode reasoning ("nothing calls this, R8 can
# remove or rename it") is wrong for it: something OUTSIDE this compilation unit resolves the name.

# --- The JNI peer: renaming or stripping this breaks the native library with NO compile error ---
#
# hev-socks5-tunnel's hev-jni.c resolves this class at JNI_OnLoad time with
# FindClass(PKGNAME "/" CLSNAME), both baked in at compile time by the -DPKGNAME/-DCLSNAME flags in
# app/build.gradle.kts — there is no Kotlin-side reference R8 can trace. Once the class is found,
# hev-jni.c registers its three native methods (TProxyStartService, TProxyStopService,
# TProxyGetStats) by NAME against the class's declared `external fun`s; R8 renaming any of them
# breaks that registration exactly the same way, just one step later at TProxyStartService() call
# time instead of at System.loadLibrary() time. Keeping the class keeps both the FindClass lookup
# and the native method names/signatures intact.
-keep class dev.enkaku.guestagent.route.Tun2Socks {
    native <methods>;
}

# --- Components the host or the OS resolves by literal class name, not by a Kotlin reference ---
#
# The default proguard-android-optimize.txt (referenced above this file in build.gradle.kts) already
# keeps every Activity/Service/BroadcastReceiver subclass by wildcard, so these names would survive
# even without this block. They are named explicitly anyway because this is the one file that
# documents, for a future reader who does not have AndroidManifest.xml open, exactly which classes
# something outside this app's own Kotlin code reaches by name: `adb shell am start -n
# dev.enkaku.guestagent/.BootstrapActivity`, the launcher resolving `.StatusActivity`, the system
# binding `.control.ControlService` and `.route.RouteVpnService`, and BOOT_COMPLETED reaching
# `.BootReceiver`.
-keep class dev.enkaku.guestagent.BootstrapActivity { *; }
-keep class dev.enkaku.guestagent.StatusActivity { *; }
-keep class dev.enkaku.guestagent.control.ControlService { *; }
-keep class dev.enkaku.guestagent.route.RouteVpnService { *; }
-keep class dev.enkaku.guestagent.BootReceiver { *; }

# --- The IME (plan 90 step 90.5): bound by the system (BIND_INPUT_METHOD) and activated by the
# host by component name via `ime enable` / `ime set` — R8 cannot see either reference. ---
-keep class dev.enkaku.guestagent.input.EnkakuIme { *; }

# --- The label facet (plan 90 step 90.5's Task B): no direct reference either — `ControlService`
# reaches it through plain Kotlin calls that R8 already traces, but WallpaperFacet's public shape
# is kept explicitly for the same "documents what something outside this file's own Kotlin reaches
# by name" reason `ControlService`/`RouteVpnService` are kept above (SharedPreferences keys are
# plain strings, not reflectable, so nothing else here needs a rule). ---
-keep class dev.enkaku.guestagent.label.WallpaperFacet { *; }
