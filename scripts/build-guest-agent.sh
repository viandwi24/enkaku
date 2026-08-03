#!/usr/bin/env bash
# On-device guest agent build (plan 43 §5.2).
#
# The APK is provisioned to devices through the Toolchain Manager with a pinned
# sha256, exactly like adb and the ui-server inspector — so what this script
# produces is a release artifact to publish and pin, never a file to commit.
set -euo pipefail
cd "$(dirname "$0")/.."

VARIANT="release"
GRADLE_TASK="assembleRelease"
if [[ "${1:-}" == "--debug" ]]; then
  VARIANT="debug"
  GRADLE_TASK="assembleDebug"
fi

# AGP 9 requires JDK 17 (minimum and default). Honour an explicit JAVA_HOME, then
# fall back to the Homebrew keg, which is what the README tells you to install.
if [[ -z "${JAVA_HOME:-}" ]]; then
  BREW_JDK="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
  if [[ -d "$BREW_JDK" ]]; then
    export JAVA_HOME="$BREW_JDK"
  elif command -v /usr/libexec/java_home >/dev/null 2>&1; then
    export JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null || true)"
  fi
fi
if [[ -z "${JAVA_HOME:-}" || ! -x "${JAVA_HOME}/bin/java" ]]; then
  echo "JDK 17 not found. Install it with: brew install openjdk@17" >&2
  echo "Then either export JAVA_HOME or re-run — see apps/guest-agent/README.md" >&2
  exit 1
fi

# The Android SDK location. `android create` writes apps/guest-agent/local.properties
# on first scaffold; ANDROID_HOME wins when set (CI has no local.properties).
if [[ -n "${ANDROID_HOME:-}" ]]; then
  export ANDROID_HOME
elif [[ ! -f apps/guest-agent/local.properties ]]; then
  if [[ -d "$HOME/Library/Android/sdk" ]]; then
    export ANDROID_HOME="$HOME/Library/Android/sdk"
  else
    echo "Android SDK not found: set ANDROID_HOME or install the Android CLI" >&2
    echo "  brew tap android/tap && brew install --cask android-cli && android sdk install" >&2
    exit 1
  fi
fi

echo "==> Building the guest agent ($VARIANT) with JDK at $JAVA_HOME"
cd apps/guest-agent
./gradlew "$GRADLE_TASK"

APK="app/build/outputs/apk/$VARIANT/app-$VARIANT.apk"
if [[ ! -f "$APK" ]]; then
  echo "Build reported success but $APK is missing" >&2
  exit 1
fi

echo
echo "Done. Artifact: apps/guest-agent/$APK"
echo "sha256: $(shasum -a 256 "$APK" | cut -d' ' -f1)"
echo
echo "For local development, point the core at it without publishing a release:"
echo "  ENKAKU_GUEST_AGENT_PATH=\$PWD/apps/guest-agent/$APK bun run dev"
