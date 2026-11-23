# Metrics

Implementation: `app/src/metrics/analyzeSwing.ts`. Verified against the forward
model in `app/src/simulation/swingModel.ts` (`app/test/metrics`).

## Frames

| Frame | Axes | Origin of the definition |
| --- | --- | --- |
| Sensor S | IMU axes as printed on the Puck.js PCB | hardware |
| Racket R | **x** along the long axis towards the tip · **z** normal to the string bed, out of the face you hit forehands with · **y** = z × x | two-pose calibration |
| World W | **z** up; heading arbitrary | gravity at the attitude anchor |

Heading is unobservable without a magnetometer and is never used: every
reported angle is an **elevation** (angle above the horizontal plane), which is
heading-invariant.

Units inside the code are SI (m/s², rad/s, s). Degrees and km/h appear only in
the UI and in rule thresholds.

## Calibration

1. Racket flat, forehand face up → measured gravity gives racket **+z**.
2. Racket on its butt cap, tip up → gives **+x**, orthogonalised against z.

The face normal is taken as exact because the sensor sits on the string bed; a
sloppy second pose therefore does not affect face angle. The poses must be
70–110° apart and static (‖a‖ within 0.05 g of 1 g, ‖ω‖ < 0.15 rad/s). The mean
gyro rate over both poses is the gyro bias. Calibration is stored per sensor.

## Pipeline

1. **Racket frame.** Bias-corrected gyro and accelerometer rotated into R.
2. **Racket rate.** ω⊥ = √(ωy² + ωz²): rotation that moves the head. Roll about
   the long axis is excluded.
3. **Active phase.** Around the peak of ω⊥, while ω⊥ > 15 % of peak.
4. **Contact.** The onset of the largest jump in specific force (> 6 g between
   consecutive samples) within ±80 ms of peak ω⊥. Near the peak the centripetal
   acceleration is momentarily constant, while ball impact is a near-step of
   tens of g; searching the whole swing would mistake the rapidly growing
   centripetal acceleration of a very fast swing for contact. No jump → shadow
   swing or miss; metrics are then taken at peak ω⊥ and `impactDetected` is
   false. The 6 g threshold assumes a string-bed mount and must be checked for
   the butt-cap mount during bring-up.
5. **Attitude.** The sample before the forward swing that is closest to static
   (‖f‖ ≈ 1 g, small ‖ω‖) anchors the tilt; quaternion integration of the gyro
   (trapezoidal rate) carries it to contact. During the swing the accelerometer
   reads tens of g of centripetal acceleration and is useless for tilt, so the
   anchor must be in the preparation phase. If its gravity error exceeds 0.2 g,
   angles are reported as unavailable. Gyro drift over the ~1 s between anchor
   and contact is ≈ bias × 1 s, i.e. well under 1° after calibration.

## Definitions

| Metric | Definition |
| --- | --- |
| `headSpeedMps` | ‖ω × x̂‖ · L at contact, L = lever from the centre of rotation to the sweet spot (setting, default 1.0 m) |
| `swingPathDeg` | Elevation of ω × x̂ (direction of sweet-spot velocity) at contact. Positive = low to high |
| `faceTiltDeg` | Elevation of the **hitting** face normal at contact. 0 = vertical, negative = closed, positive = open. The hitting face is the one whose normal points along the velocity |
| `tipElevationDeg` | Elevation of x̂ at contact |
| `peakSpeedOffsetMs` | Time of peak ω⊥ minus time of contact. Negative = the racket was already slowing down at contact |
| `preparationTimeMs` | Time from the end of the last standstill of ≥ 0.3 s (the ready position; ‖ω‖ < 0.5 rad/s) to contact. Unavailable if the capture holds no such standstill |
| `backswingArcDeg` | ∫‖ω‖dt from the start of the preparation to the start of the forward swing |
| `backswingPauseMs` | Longest standstill inside the preparation: a stop between take-back and forward swing |
| `racketDropDeg` | Lowest tip elevation between the start of the preparation and contact. Clearly negative = the head dropped below the hand |
| `faceAtDropDeg` | Elevation of the hitting-face normal at that lowest point (negative = strings facing the ground) |
| `peakAccelerationOffsetMs` | Time of peak d(ω⊥)/dt relative to contact. Close to contact = the racket lags and whips through |
| `faceClosingRateDps` | −d(face tilt)/dt at contact: how fast the hitting face is closing |
| `forwardSwingArcDeg` | ∫‖ω‖dt from start of the active phase to contact |
| `followThroughArcDeg` | ∫‖ω‖dt from contact to end of the active phase |
| `strokeType` | `overhead` if tip elevation > 35°; otherwise `forehand` / `backhand` from the hitting face |
| `swingSize` | `compact` if speed < 14 m/s **and** forward arc < 80° (volleys, blocks); else `full` |

### The rigid-lever model (ADR 0003)

The accelerometer saturates at ±16 g during a full swing (ω ≈ 25 rad/s at
~0.9 m gives ≈ 57 g of centripetal acceleration), so racket velocity cannot be
obtained by integrating acceleration. Instead the racket is treated as the end
of a rigid lever whose centre of rotation lies on the extension of the racket
axis behind the handle. Then the sweet-spot velocity is ω × (L x̂):

- its **direction** (swing path) depends only on the measured ω and the
  calibrated axis, not on L;
- its **magnitude** scales with L, which is why speed is configurable and why
  speeds should be compared within a player rather than against tour data.

In simulation, moving the centre of rotation off the racket axis (for a fixed
rotation axis) changes speed by the ratio of the true to the assumed lever and
leaves swing path unchanged; roll about the racket axis (forearm pronation)
affects neither. Real strokes also change the rotation axis during the swing
(wrist, elbow), which the model cannot capture, so swing path must be validated
with video (see [bring-up](bring-up.md)).

Only the single highest-priority cue is spoken per stroke. A stroke is called
"Good" only when every applicable rule could be evaluated; otherwise it is
marked "No reading", not spoken, and left out of the good-share statistic.

## Coaching thresholds

Values from the literature, widened by a tolerance so that cues fire on clear
faults only. Defined in `app/src/coaching/defaultRules.ts`; groundstrokes with
a full swing only.

| Rule | Fires when | Reference value | Source |
| --- | --- | --- | --- |
| Face too open | face > 0° | −20…−5° (70–85° to the ground) on topspin forehands | Kwon et al. 2017, *J Sports Sci Med* 16:505 |
| Face too closed | face < −30° | as above | Kwon et al. 2017 |
| Swing low to high | path < 12° | ≈ 17° upward racket path into contact | Elliott et al. 1989, as summarised in ISBS proceedings |
| Drive through the ball | path > 55° | up to ≈ 48° for heavy topspin | Elliott et al. 1989 (ibid.) |
| Accelerate through contact | peak speed > 40 ms before contact | peak horizontal racket speed ≈ 2–3 ms before contact in elite players | Landlinger et al. 2010, *J Sports Sci Med* 9:643 |
| Finish your swing | follow-through < 120° | — | heuristic, to be tuned |
| Prepare earlier | preparation < 600 ms | — | heuristic |
| Drop the racket head | racket drop > −15° | — | heuristic |
| Face down on the take-back | face at the drop > 20° | — | heuristic |
| Keep the swing flowing | pause > 200 ms | — | heuristic |
| Loosen the wrist | peak acceleration > 150 ms before contact | — | heuristic, indirect |

Kwon et al. also report that unsuccessful strokes show greater variability in
impact angle; the session view therefore shows the standard deviation of each
metric as a consistency measure.

Only the single highest-priority cue is spoken per stroke.

### What the sensor cannot say about the wrist

Wrist angle is the angle between forearm and racket; a racket-only sensor
cannot measure it, nor grip pressure. "Loosen the wrist" is inferred from the
racket not lagging behind the hand (early acceleration peak) and is presented
as a hint. A second sensor on the forearm would be needed to measure it.

### Explanations

Each cue has a plain-language meaning, a fix and a drill in Estonian and
English (`app/src/coaching/guidance.ts`); spoken cues stay English. After a
session, `buildSessionReport` names one focus: the most frequent correction,
if it occurred at least 5 times and in at least 25 % of the rated strokes of
that type.

## Known limitations

- Sensor range: ±2000 dps (nominally ±2293 dps with 70 mdps/LSB). Very fast
  swings clip. Speed is then flagged as a lower bound and excluded from
  statistics. Every clipped sample loses rotation and degrades attitude (in
  simulation ≈ 1° at 6 clipped samples, ≈ 8° at 20), so angles are withheld when
  more than 6 samples clip between the attitude anchor and contact; the stroke
  then gets "No reading" instead of a rating.
- Published face-angle and swing-path values are for topspin forehands; the
  same thresholds are applied to backhands until backhand data is available.
- 104 Hz sampling gives ±5 ms timing resolution at contact.
- Contact location on the string bed is not yet estimated (planned, needs
  recorded data).
- Body kinematics (footwork, trunk rotation, contact point relative to the
  body) are invisible to a racket sensor.
