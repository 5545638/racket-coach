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
4. **Contact.** First sample after the start of the active phase where the
   specific force jumps by > 6 g between consecutive samples. Swing
   acceleration changes by a few g per sample at 104 Hz; a string-bed impact is
   a near-step of tens of g. No jump → shadow swing or miss; metrics are then
   taken at peak ω⊥ and `impactDetected` is false.
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

Real strokes violate the model when the wrist and elbow add rotation about
other centres. Swing path is therefore an estimate of the racket's own motion
and must be validated with video (see [bring-up](bring-up.md)).

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

Kwon et al. also report that unsuccessful strokes show greater variability in
impact angle; the session view therefore shows the standard deviation of each
metric as a consistency measure.

Only the single highest-priority cue is spoken per stroke.

## Known limitations

- Sensor range: ±2000 dps (nominally ±2293 dps with 70 mdps/LSB). Very fast
  swings clip; speed is then flagged as a lower bound and excluded from
  statistics. Angles remain usable because attitude error from a short clip is
  small, but they are less accurate.
- 104 Hz sampling gives ±5 ms timing resolution at contact.
- Contact location on the string bed is not yet estimated (planned, needs
  recorded data).
- Body kinematics (footwork, trunk rotation, contact point relative to the
  body) are invisible to a racket sensor.
