# Research notes for the coaching engine

Compiled 2026-11-24 by a research agent. Most sources were read as abstracts or
secondary pages; several primary papers were blocked. Treat every number as
"reported", not verified. Racket-only serve kinematics are largely unpublished.

## Serve

- Contributions to racket-head speed (film data, high-performance servers):
  upper-arm internal rotation ~40–54 %, wrist flexion ~30 %, shoulder ~10 %,
  forearm pronation ~5 %, elbow extension negative. Elliott et al. 1995 as
  quoted by Marshall (ISBS proceedings); Elliott 2006, Br J Sports Med.
  Peak rates quoted: internal rotation 37 rad/s, pronation 15 rad/s (no n/SD).
- Gordon & Dapena 2006 (J Sports Sci 24:31–49, n = 9): pronation made a brief
  negative contribution (abstract, no numbers).
- Consequence for the design: a racket gyro sees the summed long-axis rotation
  of the whole chain; it cannot isolate pronation. The cue describes the
  racket turning over, not the forearm.
- Low point to impact: 0.11–0.13 s, n = 4, no SD (Gorce & Jacquier-Bret 2024,
  already in serve-volley.md). Racket orientation at maximal external rotation,
  shaft tilt at impact and racket angular velocity at impact: not found.
- Ahmadi et al. 2009 (Sports Technology 2): arm-worn gyros; peak upper-arm
  internal rotation, wrist flexion and shoulder rotation rates rose with skill
  (abstract, no numbers).
- Whiteside et al. 2017: a WRIST-worn IMU (not racket) classified
  overhead/forehand/backhand at 97.4 % (10-fold CV, 19 athletes).

## Backhand

- Busuttil et al. 2020 (ISBS, n = 16 sub-elite adolescents, two-handed topspin):
  peak horizontal racket-head speed 25.8 ± 2.7 m/s (eastern) vs 23.4 ± 2.0
  (continental); horizontal speed at impact 17.7 ± 1.9 vs 16.5 ± 2.1 m/s.
- One- vs two-handed face angle and take-back timing: not found beyond backhand.md.

## Preparation, lag, follow-through, recovery

- Take-back start in ms relative to bounce or impact, and take-back rotation in
  degrees about vertical: not found (Landlinger's racket angle needs heading).
- Wrist "lag" in the literature is a hand–forearm joint angle; it needs a
  forearm or hand segment and cannot come from a racket-only sensor.
- Follow-through duration for forehands and recovery time between strokes:
  not found.

## Racket-sensor validation and variability

- Delgado-García et al. (IJRSS 4(2)): Zepp racket speed vs 3D reference, MAE
  ≈ 7–9 km/h; forehand CCC 0.75, backhand 0.56 (backhand worse).
- Within-player racket-angle SD: only Knudson & Blackwell 2005 (n = 7 advanced):
  face 2.8°, path 3.4°, speed 1.5 m/s. No amateur data found.

## Motor learning for real-time feedback

- Bandwidth feedback (only outside a tolerance band): lower error and more
  consistent retention in a lab task (Lee & Carnahan 1990, abstract).
- Reduced-frequency feedback meta-analysis (Marschall, Bund & Wiemeyer 2007,
  40 studies): small, fragile effects; mainly lab tasks.
- Feedback after good trials beat feedback after poor trials on delayed
  retention (Chiviacowsky & Wulf 2007, beanbag throwing); later work attributes
  part of the benefit to learner control (Carter et al. 2014).
- No racket-sport bandwidth-feedback study found.

## Open gaps

Racket angular velocity at impact (any stroke); serve back-scratch racket
orientation and shaft tilt at impact; racket-IMU angle validation against
motion capture with SDs; take-back timing and rotation; follow-through and
recovery durations; amateur within-player racket-angle SD.
