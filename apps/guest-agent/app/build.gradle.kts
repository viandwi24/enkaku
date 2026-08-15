plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "dev.enkaku.guestagent"
    compileSdk = 36
    defaultConfig {
        applicationId = "dev.enkaku.guestagent"
        // 29, not 26: hev-socks5-tunnel's own Application.mk pins APP_PLATFORM to android-29, which
        // is the floor upstream actually tests. Farm devices below this report `unsupported` in
        // Studio (plan 43 §4.5) rather than failing at runtime.
        minSdk = 29
        targetSdk = 36
        // Release-driven, not a constant (plan 90 §3.11/§4.8, R4): `.github/workflows/release.yml`
        // derives both from the `v*` tag and exports them before Gradle runs, so the value the
        // toolchain manifest pins (`deviceArtifact.versionCode`) and the value baked into the APK
        // are always the same tag. A local dev build has no tag and no env override, so it falls
        // back to 1/"dev" — fine, because nothing verifies a dev build's version.
        versionCode = System.getenv("ENKAKU_GUEST_AGENT_VERSION_CODE")?.toIntOrNull() ?: 1
        versionName = System.getenv("ENKAKU_GUEST_AGENT_VERSION_NAME") ?: "dev"

        externalNativeBuild {
            ndkBuild {
                // hev-jni.c resolves its Java peer with FindClass(PKGNAME "/" CLSNAME), so these
                // must track the Kotlin class declaring the three external methods. Verified
                // against src/hev-jni.c at tag 2.16.0 — note it exports three, not four:
                // TProxyStartService(String,int), TProxyStopService(), TProxyGetStats().
                cFlags += listOf(
                    "-DPKGNAME=dev/enkaku/guestagent/route",
                    "-DCLSNAME=Tun2Socks",
                )
                // Only the shared library. Android.mk also defines a standalone executable
                // (hev-socks5-tunnel-bin) that we never ship and would only pay build time for.
                targets += "hev-socks5-tunnel"
            }
        }

        ndk {
            // Real phones plus emulators and redroid. 32-bit x86 is dead and not worth the build time.
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
        }
    }

    externalNativeBuild {
        ndkBuild {
            path = file("../third_party/hev-socks5-tunnel/Android.mk")
        }
    }

    // CI-only (`ENKAKU_GUEST_AGENT_KEYSTORE_PATH` unset locally): a release build with no keystore
    // configured stays unsigned, exactly as it always has (`app-release-unsigned.apk`), so a local
    // `bun run build:guest-agent` needs no secrets. `.github/workflows/release.yml` decodes the CI
    // keystore secret to a file and sets the four env vars below before invoking Gradle.
    val releaseKeystorePath = System.getenv("ENKAKU_GUEST_AGENT_KEYSTORE_PATH")
    signingConfigs {
        if (releaseKeystorePath != null) {
            create("release") {
                storeFile = file(releaseKeystorePath)
                storePassword = System.getenv("ENKAKU_GUEST_AGENT_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ENKAKU_GUEST_AGENT_KEY_ALIAS")
                keyPassword = System.getenv("ENKAKU_GUEST_AGENT_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // R8 on (plan 90 §3.11, fixes F2): it was off with `proguardFiles(...)` configured on
            // the very next line and therefore never applied. `proguard-rules.pro` keeps the JNI
            // peer, the manifest-declared components, and the (not-yet-landed) IME by name.
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (releaseKeystorePath != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
      aidl = false
      buildConfig = false
      shaders = false
    }

    packaging {
      resources {
        excludes += "/META-INF/{AL2.0,LGPL2.1}"
      }
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
  // Core Android dependencies
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.lifecycle.runtime.ktx)

  // Local tests: jUnit, coroutines, Android runner
  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)

  // Instrumented tests: jUnit rules and runners
  androidTestImplementation(libs.androidx.test.core)
  androidTestImplementation(libs.androidx.test.ext.junit)
  androidTestImplementation(libs.androidx.test.runner)
  androidTestImplementation(libs.androidx.test.espresso.core)
}
