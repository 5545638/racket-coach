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

The face normal is taken as exact and the long axis is orthogonalised against
it, so a sloppy second pose does not affect face angle. The face-up pose is
trusted because it is easy to repeat (racket flat on the ground), not because
of the mount: the sensor sits in the butt cap. The poses must be
70–110° apart and static (‖a‖ within 0.05 g of 1 g, ‖ω‖ < 0.15 rad/s). The mean
gyro rate over both poses is the gyro bias. Calibration is stored per sensor.

## Pipeline

1. **Racket frame.** Bias-corrected gyro and accelerometer rotated into R.
2. **Racket rate.** ω⊥ = √(ωy² + ωz²): rotation that moves the head. Roll about
   the long axis is excluded.
3. **Active phase.** Around the peak of ω⊥, while ω⊥ > 15 % of peak.
4. **Contact.** The onset of the largest sample-to-sample jump, in specific
   force (> 6 g) or in angular rate (> 7 rad/s ≈ 400 °/s), within ±80 ms of
   peak ω⊥. The rotation jolt matters for a sensor in the handle, where the
   acceleration transient is weak. Near the peak the centripetal
   acceleration is momentarily constant, while ball impact is a near-step of
   tens of g; searching the whole swing would mistake the rapidly growing
   centripetal acceleration of a very fast swing for contact. No jump → shadow
   swing or miss; metrics are then taken at peak ω⊥, `impactDetected` is
   false and the stroke is not rated (below). The 6 g threshold must be
   checked for the butt-cap mount during bring-up.
5. **Contact sample.** The jump at sample k compares samples k − 1 and k, so
   sample k (`referenceIndex`) already shows the post-impact racket: the
   impact transient, and a rate that has dropped to about 80 % (Elliott et al.
   1989: the racket keeps ≈ 80 % of its velocity; research/racket-dynamics.md
   §1.2). Reading speed there reads it ≈ 20 % low. Contact kinematics are
   therefore read from **k − 1**, the last clean sample, and the contact time
   is taken as **k − 0.5** (the middle of the interval known to contain it;
   a design choice that bounds the timing error to ±½ sample ≈ ±4.8 ms).
   Speed uses the rate at k − 1 as is (it is near its peak and changes
   little). Angles (face, path, tip, closing rate) are extrapolated linearly
   by half a sample from samples k − 2 and k − 1; carrying the attitude
   forward at a constant body rate instead let forearm roll tilt the path by
   ≈ 4° in simulation. Timing metrics are measured from k − 0.5. Without an
   impact, the peak sample is both the reading and the timing reference.
6. **Attitude.** Tilt is anchored on a **quiet window** before the forward
   swing: the latest run of ≥ 100 ms (round(0.1·fs) samples) in which every
   sample is unsaturated and rotates slower than 0.5 rad/s, each specific-force
   axis varies by less than 0.03 g (standard deviation) and drifts by less
   than 0.01 g (second-half mean minus first-half mean), and the mean
   specific force is within 0.05 g of 1 g. Gravity is the window mean (samples
   rotated into the frame of the last one with the gyro), and the attitude is
   anchored at the window's last sample. Quaternion integration of the gyro
   (trapezoidal rate) carries it to contact. During the swing the
   accelerometer reads tens of g of centripetal acceleration and is useless
   for tilt, so the anchor must be in the preparation phase. If no window
   qualifies, the attitude is not reliable and all angles are reported as
   unavailable ("No reading"). Gyro drift over the ~1 s between anchor and
   contact is ≈ bias × 1 s, i.e. well under 1° after calibration.

   Why a window: a norm check on a single sample cannot see acceleration
   perpendicular to gravity. 0.66 g sideways changes ‖f‖ by only 0.2 g but
   tilts the apparent vertical by 33°, and the onset of a swing produces
   exactly such samples. The former single-sample anchor picked one when the
   ready position was slightly restless and reported the face ≈ 33° off while
   calling it reliable (regression test in `app/test/metrics`). The drift
   limit rejects the slowly rising tangential acceleration at swing onset,
   which a spread limit alone lets through. Remaining blind spot: a steady
   sideways acceleration lasting the whole window passes up to 0.32 g
   (√(1 + 0.32²) − 1 ≈ 0.05), i.e. up to 18° of tilt; a ready position rarely
   does that. All thresholds are engineering choices to be tuned on recorded
   data (`AnalysisParams`).

## Definitions

| Metric | Definition |
| --- | --- |
| `headSpeedMps` | ‖ω × x̂‖ · L at the last pre-impact sample, L = lever from the centre of rotation to the sweet spot (setting, default 0.72 m). A model estimate: compare it with your own earlier strokes (a personal trend), not with published speeds |
| `swingPathDeg` | Elevation of ω × x̂ (direction of sweet-spot velocity) at contact. Positive = low to high |
| `faceTiltDeg` | Elevation of the **hitting** face normal at contact. 0 = vertical, negative = closed, positive = open. The hitting face is the one whose normal points along the velocity |
| `tipElevationDeg` | Elevation of x̂ at contact |
| `peakSpeedOffsetMs` | Time of peak ω⊥ minus time of contact. Negative = the racket was already slowing down at contact. Unavailable when the gyro clipped between forward-swing start and contact |
| `preparationTimeMs` | Time from the end of the last standstill of ≥ 0.3 s (the ready position; ‖ω‖ < 0.5 rad/s) to contact. Unavailable if the capture holds no such standstill |
| `backswingArcDeg` | ∫‖ω‖dt from the start of the preparation to the start of the forward swing |
| `backswingPauseMs` | Longest standstill inside the preparation: a stop between take-back and forward swing |
| `racketDropDeg` | Lowest tip elevation between the start of the preparation and contact. Clearly negative = the head dropped below the hand |
| `faceAtDropDeg` | Elevation of the hitting-face normal at that lowest point (negative = strings facing the ground) |
| `peakAccelerationOffsetMs` | Time of peak d(ω⊥)/dt relative to contact. Close to contact = the racket lags and whips through. Unavailable when the gyro clipped between forward-swing start and contact |
| `faceClosingRateDps` | −d(face tilt)/dt at contact: how fast the hitting face is closing |
| `forwardSwingArcDeg` | ∫‖ω‖dt from start of the active phase to contact |
| `followThroughArcDeg` | ∫‖ω‖dt from contact to end of the active phase |
| `strokeType` | `overhead` if tip elevation > 35°; otherwise `forehand` / `backhand` from the hitting face. When gyro clipping withholds the displayed angles but the anchor is valid, the coarse tip elevation is still used for this classification |
| `swingSize` | `compact` if speed < 14 m/s **and** forward arc < 80° (volleys, blocks); else `full` |
| `swingStyle` | `slice` if swing path < −8°, else `drive`; unknown when the path is unavailable |

### The rigid-lever model (ADR 0003)

In the butt cap the sensor is ≈ 0.2 m from the centre of rotation, so its
centripetal acceleration ω²r exceeds the ±16 g range above ≈ 28 rad/s and it
clips in fast swings; integrating acceleration for racket velocity is also
dominated by drift and by the unknown hand motion. Instead the racket is
treated as the end of a rigid lever whose centre of rotation lies on the
extension of the racket axis behind the handle. Then the sweet-spot velocity
is ω × (L x̂):

- its **direction** (swing path) depends only on the measured ω and the
  calibrated axis, not on L;
- its **magnitude** scales with L, which is why speed is configurable and why
  speeds should be compared within a player rather than against tour data.

The default L = 0.72 m is the effective radius TennisEye used (0.2 m from the
butt to the centre of rotation plus 0.52 m from the butt to the face centre;
research/racket-dynamics.md §5). TennisEye validated ball speed, not racket
speed, and no forehand-specific radius was found, so head speed stays a
**model estimate, best used as a personal trend**. Settings stored with the
earlier default of exactly 1.0 m are migrated to 0.72 m once on load.

In simulation, moving the centre of rotation off the racket axis (for a fixed
rotation axis) changes speed by the ratio of the true to the assumed lever and
leaves swing path unchanged; roll about the racket axis (forearm pronation)
affects neither. The model cannot see the hand's own linear velocity: in
simulation, an upward hand velocity of 3 m/s at contact (24 m/s rotational
head speed) makes the true path ≈ 6–7° steeper than measured and the true
speed ≈ 6 % higher; the error grows roughly linearly with hand speed. Real
strokes also change the rotation axis during the swing (wrist, elbow), which
the model cannot capture either, so swing path must be validated with video
(see [bring-up](bring-up.md)).

Only the single highest-priority cue is spoken per stroke. A stroke is called
"Good" only when every applicable rule could be evaluated; otherwise it is
marked "No reading", not spoken, and left out of the good-share statistic.
A swing without detected ball contact (shadow swing or miss) is **not rated**
("Counted"): its metrics describe the moment of peak racket speed, not a hit,
and every threshold comes from studies of real contacts.

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
| Drop the racket head | racket drop > −15° | — | heuristic |
| Face down on the take-back | face at the drop > 20° | — | heuristic |
| Keep the swing flowing | pause > 200 ms | — | heuristic |
| Loosen the wrist | peak acceleration > 150 ms before contact | — | heuristic, indirect; no published support (see below) |
| Open the face for the slice | slice with face < 0° | face open at impact on slice backhands | Elliott & Christmass 1993, ISBS |
| Slice through the ball, not down | slice with path < −35° | racket travels 15–25° downward into contact | Elliott & Christmass 1993, ISBS |

Drive rules apply to drives only and slice rules to slices only; a stroke whose
style is unknown gets "No reading". Serves, smashes, volleys and other compact
swings are **counted but not rated** ("Counted"): the literature search in
[research/](research/README.md) found no usable racket-level reference values
for them. Preparation time is displayed without a rule, because skilled players
were measured with backswings of only 0.49–0.59 s on fast balls and what
separates skill levels (racket set before the bounce) is invisible to a racket
sensor.

Kwon et al. also report that unsuccessful strokes show greater variability in
impact angle; the session view therefore shows the standard deviation of each
metric as a consistency measure.

Only the single highest-priority cue is spoken per stroke.

### What the sensor cannot say about the wrist

Wrist angle is the angle between forearm and racket; a racket-only sensor
cannot measure it, nor grip pressure. "Loosen the wrist" is inferred from the
racket not lagging behind the hand (early acceleration peak) and is presented
as a hint. A second sensor on the forearm would be needed to measure it.

The cue is kept at the player's request as a coaching intention (loose through
the swing, firm at contact). The literature search found no study that times
peak racket acceleration, and none linking a relaxed wrist or grip to racket
speed, so the −150 ms threshold must be tuned on the player's own deliberately
loose and stiff swings before it is trusted.

### Explanations

Each cue has a plain-language meaning, a fix and a drill in Estonian and
English (`app/src/coaching/guidance.ts`); spoken cues stay English. After a
session, `buildSessionReport` names one focus: the most frequent correction,
if it occurred at least 5 times and in at least 25 % of the rated strokes of
that type.

## Known limitations

- Sensor range: ±2000 dps. With 70 mdps/LSB the int16 range would reach
  2293 dps, but the part's real clip point between 2000 and 2293 dps is not
  specified, so a gyro count ≥ 28000 (1960 dps) is treated as clipped
  (`GYRO_SATURATION_COUNTS`; to be measured during bring-up). Very fast swings
  clip. Speed is then flagged as a lower bound and excluded from statistics,
  and `peakSpeedOffsetMs` and `peakAccelerationOffsetMs` are withheld: the
  argmax of a clipped plateau lands up to ≈ 70 ms early and would fire
  "Accelerate through contact" on a well-timed swing. Every clipped sample loses rotation and degrades attitude (in
  simulation ≈ 1° at 6 clipped samples, ≈ 8° at 20), so angles are withheld when
  more than 6 samples clip between the attitude anchor and contact; the stroke
  then gets "No reading" instead of a rating.
- Published face-angle and swing-path values are for topspin forehands; the
  same thresholds are applied to backhands until backhand data is available.
- 104 Hz sampling gives ±5 ms timing resolution at contact. The face is
  therefore only known to ± (closing rate × 4.8 ms): ≈ ±4° with 15 rad/s of
  forearm roll at contact, in simulation.
- The attitude anchor needs ≥ 100 ms of stillness before the swing; without
  it, angles are not reported.
- Contact location on the string bed is not yet estimated (planned, needs
  recorded data).
- Body kinematics (footwork, trunk rotation, contact point relative to the
  body) are invisible to a racket sensor.
