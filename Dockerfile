# Enkaku core — image self-host (plan 09 §4.9).
#
# Catatan USB: akses device USB dari container merepotkan (butuh
# --device /dev/bus/usb + aturan udev host, dan adb server di host bisa
# berebut device). Untuk container, jalur yang direkomendasikan adalah
# **wireless ADB**: enroll device lewat pairing code, core connect via TCP.

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

# adb/scrcpy-server/ui-server TIDAK di-bake: Toolchain Manager mengunduhnya
# saat first run dan memverifikasi sha256 (spec §7.8). Untuk air-gapped,
# mount folder /data/tools yang sudah terisi — reconcile akan mengadopsinya.
COPY package.json bun.lock* ./
COPY packages ./packages
COPY examples ./examples
COPY --from=studio /app/packages/studio/out ./packages/studio/out
RUN bun install --frozen-lockfile --production

VOLUME ["/data"]
EXPOSE 7700

# Mode server (bind 0.0.0.0) mewajibkan TLS. Di belakang reverse proxy,
# set ENKAKU_TLS_MODE=external; untuk uji cepat pakai ENKAKU_ALLOW_INSECURE=1.
CMD ["bun", "run", "packages/core/src/index.ts"]
