plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.compose.compiler)
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
        versionCode = 1
        versionName = "1.0"

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

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
      compose = true
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
  val composeBom = platform(libs.androidx.compose.bom)
  implementation(composeBom)
  androidTestImplementation(composeBom)

  // Core Android dependencies
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.activity.compose)

  // Arch Components
  implementation(libs.androidx.lifecycle.runtime.compose)
  implementation(libs.androidx.lifecycle.viewmodel.compose)

  // Compose
  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.ui.tooling.preview)
  implementation(libs.androidx.compose.material3)
  // Tooling
  debugImplementation(libs.androidx.compose.ui.tooling)
  // Instrumented tests
  androidTestImplementation(libs.androidx.compose.ui.test.junit4)
  debugImplementation(libs.androidx.compose.ui.test.manifest)

  // Local tests: jUnit, coroutines, Android runner
  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)

  // Instrumented tests: jUnit rules and runners
  androidTestImplementation(libs.androidx.test.core)
  androidTestImplementation(libs.androidx.test.ext.junit)
  androidTestImplementation(libs.androidx.test.runner)
  androidTestImplementation(libs.androidx.test.espresso.core)
}
