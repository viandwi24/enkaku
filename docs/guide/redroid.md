# Cloud devices without physical phones (redroid)

[redroid](https://github.com/remote-android/redroid-doc) runs Android inside a container. Enkaku treats it exactly like a physical device over the `adb-tcp` transport — there is no special-case code.

```bash
docker run -itd --rm --privileged \
  -v ~/redroid-data:/data \
  -p 5555:5555 \
  redroid/redroid:14.0.0-latest

# register it with the farm: Studio → Add device → wireless, host 127.0.0.1, port 5555
```

## When this makes sense — and when it does not

**Good for:** throughput testing, exercising flows that never touch a sensor, and adding queue capacity without buying hardware.

**Not good for:** anything that depends on the characteristics of a real device. redroid is an emulator, so plenty of simple automation detection flags it immediately: no real sensors (accelerometer, gyroscope), an IMEI and serial that are not hardware, readable emulator properties, and touches that do not come from a physical input driver.

For testing that needs a genuine device — including testing your own automation detectors — use physical phones. That is exactly the structural advantage a real device farm has over emulators.
