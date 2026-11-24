# Changelog

All notable changes are documented here. Versions follow [SemVer](https://semver.org/).

## [0.1.0] — unreleased

### Added
- Natural coach voice: every spoken phrase pre-recorded with Kokoro-82M
  (English female `af_heart` / male `am_michael`, `tools/voice`), played with
  Web Audio; the device voice is the fallback for any text without a clip.
  Optional one-time download of a natural Estonian voice (TartuNLP), played
  offline. Settings version 6: `voice.engine`, `voice.profile`,
  `voice.etSpeaker`.
- Puck.js firmware: swing trigger, pre-trigger buffer, streaming protocol v1.
- Web app: Web Bluetooth and demo transports, two-pose calibration, stroke
  metrics, literature-based rules, spoken cues, session statistics, CSV/JSON
  export, IndexedDB storage.
- Preparation and wrist-proxy metrics with coaching rules; explanations, fixes
  and drills in Estonian and English; session focus report; face-angle gauge.
- Slice recognised as its own style with its own rules; serves, smashes and
  volleys are counted but not rated; contact is also detected from the jolt in
  rotation; the fixed preparation-time rule was removed (docs/research).
- Swing simulator and firmware-in-the-loop tests.
- Parametric replacement butt cap for the Puck PCB (Wilson Blade dimensions).
- Parametric two-part string clamp as an alternative mount.
- v2 capture integration (analysis version 6): sensitivities → ranges (unknown
  ones reject the capture), BEGIN_B flags, M416 splice to 416 Hz with
  measured/interpolated flags, impact onset refined by the raw gyro,
  per-capture gyro bias re-estimation, IMU temperature stored with the
  calibration (recalibration hint in Setup), JSON import and exact
  re-analysis of stored v1/v2 strokes, firmware-to-coach end-to-end test.
