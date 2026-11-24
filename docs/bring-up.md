# Hardware bring-up checklist

Everything below has been verified only in simulation. Work through it in
order with the first real Puck.js; record results in an issue.

## 1. Firmware and link

- [ ] Device advertises as `RacketCoach xxxx`; app connects from Bluefy.
- [ ] Setup shows firmware `0.1.0`, protocol v1, a plausible battery level.
- [ ] `Puck.accelRd(0x10)` returns `0x44` and `Puck.accelRd(0x11)` returns
      `0x4C` while connected (ranges ±16 g / ±2000 dps).
- [ ] `E.CRC32(E.toUint8Array("123456789"))` equals `0xCBF43926`. If not, the
      firmware CRC differs from the app's CRC-32/ISO-HDLC and every capture will
      be rejected: fix the firmware, not the app.
- [ ] Ten swings in a row arrive without "dropped" entries in
      Session → Diagnostics (otherwise: TX queue too small → lower sample rate
      or raise `RETRY_MS`).

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
      drill) and note the largest raw gyro count the sensor ever reports.
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
      at ~100 notifications/s; if it lasts less than one session, consider the
      XIAO nRF52840 Sense variant with a Li-Po cell (protocol unchanged).
