# Hardware bring-up checklist

Everything below has been verified only in simulation. Work through it in
order with the first real Puck.js; record results in an issue.

## 1. Firmware and link

- [ ] Device advertises as `RacketCoach xxxx`; app connects from Bluefy.
- [ ] Setup shows firmware `0.2.0`, protocol v2, a plausible battery level and
      a Diagnostics line (mode M104, P 48 on most phones; P 18 means the phone
      kept MTU 23, which works but is slower).
- [ ] Bench T2 (section 6) reports WHO_AM_I `0x6A`, CTRL1_XL `0x46` and
      CTRL2_G `0x4C` in M104 (`0x64` / `0x6C` in M416): register writes work
      without `Puck.accelOn` (ranges ±16 g / ±2000 dps).
- [ ] `E.CRC32(E.toUint8Array("123456789"))` equals `0xCBF43926`. If not, the
      firmware CRC differs from the app's CRC-32/ISO-HDLC and every capture will
      be rejected: fix the firmware, not the app.
- [ ] Ten swings in a row arrive; Setup → Diagnostics still shows 0 FIFO
      overruns, 0 dropped strokes and 0 errors. Dropped strokes with an idle
      link mean the outbox timed out (no ACKs arrive: check that the control
      characteristic accepts write without response, T5).
- [ ] With an app that sends no HELLO (an older build of this app), swings
      still arrive as v1 captures.

## 2. Axes and calibration

- [ ] Calibration succeeds; poses are reported ~90° apart.
- [ ] Hold the racket face vertical and swing slowly from low to high: swing
      path positive, face near 0°.
- [ ] Tilt the hitting face up and repeat: face positive ("open").
- [ ] Forehands are labelled forehand, backhands backhand.

## 3. Mechanics

- [ ] Butt-cap fit test print seats like the stock cap; full cap holds the PCB
      without rattling.
- [ ] Mount survives 200 hard groundstrokes without moving.
- [ ] No sensor resets on impact: a reset drops the BLE connection, so the app
      must stay connected through a full session. If it does not, increase
      `stack_interference` in the clamp to press the coin cell harder.
- [ ] Contact is detected on every hit and on no shadow swing. In the handle
      the impact is weaker than on the strings: if hits are missed, lower
      `impactJumpThresholdG` (default 6 g) using the exported raw data.
- [ ] Gyro clip point: swing as fast as possible (or spin the racket on a
      drill) and note the largest raw gyro count the sensor ever reports
      (bench T7 reports it per axis since its last reset).
      The app treats ≥ 28000 counts (1960 dps) as clipped
      (`GYRO_SATURATION_COUNTS` in `app/src/processing/units.ts`), just below
      the nominal ±2000 dps = 28571 counts; the int16 limit (32767 counts,
      2293 dps) is not a reliable clip point. Set the threshold just below the
      measured plateau.
- [ ] Ready position: check in the exported data that a normal ready
      position yields a quiet anchor window (≥ 100 ms, ‖ω‖ < 0.5 rad/s,
      per-axis accelerometer spread < 0.03 g, drift < 0.01 g, ‖mean‖ within
      0.05 g of 1 g). If strokes often show "No reading" with
      `anchorErrorG` empty, the thresholds are too strict for real hands.

## 4. Validation against video

Film 30 forehands at 240 fps from the side with the court line visible.

- [ ] Face angle at contact from video vs. app: mean difference < 5°.
- [ ] Swing path (sweet-spot trajectory over the last 3 frames before contact)
      vs. app: mean difference < 7°. If larger, the rigid-lever model needs a
      correction (ADR 0003).
- [ ] Export the session JSON and add five strokes as regression fixtures in
      `app/test/fixtures/`.

## 5. Battery

- [ ] Battery % after a 60-minute session. CR2032 is the expected weak point
      (bench T8); if it lasts less than one session, consider the XIAO
      nRF52840 Sense variant with a Li-Po cell (protocol unchanged).

## 6. Bench tests T1–T9

The firmware's assumptions about the IMU, the I2C bus and the BLE stack are
unverified ([sensor-v2.md](sensor-v2.md)). Run these on the bench before
trusting captures, and before switching M416 on. Use Chrome on a computer
(Web Bluetooth plus DevTools): connect the app to the sensor, open the console
and run `racketCoach.runBench(test, param)`. Results appear as hex bytes in
Session → Diagnostics; payload layouts are in
[ble-protocol.md](ble-protocol.md#bench-results). T1 and T2 reset the FIFO; do
not swing while they run. Record every result in the bring-up issue.

| Test | How | Pass / record |
| --- | --- | --- |
| T1 | `runBench(1, 10)` in M104 | µs for 30/120/240-byte FIFO bursts and one register write. Compute ms per byte from the 240-byte burst. |
| T2 | `runBench(2)` in M104, then again after enabling M416 | WHO_AM_I `0x6A`; CTRL registers as configured; pattern ok = 1; words before − after the burst = 6 (M104) or 15 (M416). Otherwise the frame layout or the burst wrap differs from the model: stop and fix the firmware. |
| T3 | `runBench(3, 4)` per mode | Frame rate ≈ 104.17 Hz by both clocks; IMU timer vs getTime() within ±1 % (datasheet tolerance not checked). |
| T4 | `runBench(4, 60)` per mode, waving the racket and swinging during the minute | 0 overruns; max FIFO fill well below 2048 words; poll() mean/max time; max gap between polls < 500 ms. |
| T5 | `runBench(5, n)` for n = 1 … 6, at arm's length and at 5 m | The log shows how many of the 200 numbered packets arrived; loss per n; bytes/s = received × P / duration. Pick the largest n with no loss for PACING, and check that v1 pacing (4 per 30 ms) is loss-free. Indications are not tested (not available from this firmware). |
| T6 | `runBench(6)` in M416 after ≥ 3 s connected | free memory with all buffers allocated (must stay > ~500 vars); extract() duration (must be well below the FIFO's 1.31 s in M416). |
| T7 | `runBench(7, 1)` after the fastest swings you can make | Largest raw count per axis: is the gyro plateau at 28571 or 32767? Adjust `GYRO_SATURATION_COUNTS` (app) and `GYRO_CLIP_COUNTS` (firmware). |
| T8 | External meter in series with the coin cell | Current idle-connected and while sending, per mode; CR2032 voltage sag during a send. |
| T9 | M416, hit balls, export raw data | Spectrum of the H section around impact: is the ~146 Hz frame mode visible at the butt cap? |

### Decision rule for M416

Keep the default M104. Make M416 the default (firmware `DEFAULT_MODE` and the
app setting) only when all of these hold:

1. T1: the 240-byte burst costs ≤ 0.15 ms per byte (≤ 36 ms), i.e. a 30 ms
   poll in M416 (~100 bytes) stays below ~15 ms.
2. T2 passes in M416 (pattern G0, A0, G1, G2, G3 and burst wrap confirmed).
3. T4 in M416 over 60 s with swings: 0 overruns, max fill < 1024 words, max
   poll gap < 500 ms.
4. T6: extract() in M416 < 300 ms and free memory > 500 vars.
5. T5: the hybrid capture (73 blocks at P 48) arrives without NAK rounds at the
   chosen pacing in normal use.
6. T8: the M416 current does not shorten a session below 60 minutes.

If any fails, ship M104 and leave M416 as the experimental setting.
