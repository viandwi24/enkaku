# Enkaku core — self-host image (plan 09 §4.9).
#
# USB note: accessing a USB device from a container is awkward (it needs
# --device /dev/bus/usb + host udev rules, and the host's adb server can
# fight over the device). For containers, the recommended path is
# **wireless ADB**: enroll the device via pairing code, the core connects over TCP.

FROM oven/bun:1 AS studio
WORKDIR /app
COPY package.json bun.lock* ./
COPY packages ./packages
COPY examples ./examples
RUN bun install --frozen-lockfile
RUN bun run --cwd packages/studio build

FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production \
    ENKAKU_DATA_DIR=/data \
    ENKAKU_BIND=0.0.0.0 \
    ENKAKU_PORT=7700 \
    ENKAKU_STUDIO_DIST=/app/packages/studio/out

# adb/scrcpy-server/ui-server are NOT baked in: the Toolchain Manager downloads them
# on first run and verifies their sha256 (spec §7.8). For air-gapped setups,
# mount an already-populated /data/tools folder — reconcile will adopt it.
COPY package.json bun.lock* ./
COPY packages ./packages
COPY examples ./examples
COPY --from=studio /app/packages/studio/out ./packages/studio/out
RUN bun install --frozen-lockfile --production

VOLUME ["/data"]
EXPOSE 7700

# Server mode (bind 0.0.0.0) requires TLS. Behind a reverse proxy,
# set ENKAKU_TLS_MODE=external; for a quick test use ENKAKU_ALLOW_INSECURE=1.
CMD ["bun", "run", "packages/core/src/index.ts"]
