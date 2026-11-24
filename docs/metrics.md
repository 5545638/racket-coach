# Metrics

Implementation: `app/src/metrics/analyzeSwing.ts` (metrics), with the shared
pipeline steps in `kinematics.ts`, the coaching features in `features.ts` and
their uncertainty in `uncertainty.ts`. Verified against the forward model in
`app/src/simulation/swingModel.ts` (`app/test/metrics`).

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
4. **Contact.** The onset of the largest jump over one reference interval
   (1/104 s; see "Signal path v2" for the rate-agnostic form and the
   consistency rules), in specific force (> 6 g) or in angular rate
   (> 7 rad/s ≈ 400 °/s), within ±80 ms of peak ω⊥. The rotation jolt matters for a sensor in the handle, where the
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

Only one cue is spoken per stroke; which one is decided by the coaching
engine above, using these limits as population limits. A stroke is called
"Good" only when every applicable rule could be evaluated; otherwise it is
marked "No reading", not spoken, and left out of the good-share statistic.
A swing without detected ball contact (shadow swing or miss) is **not rated**
("Counted"): its metrics describe the moment of peak racket speed, not a hit,
and every threshold comes from studies of real contacts.

## Coaching features

`StrokeMetrics.features` (analysis version 3 and later; optional because older
records lack it). Pure functions of the intermediate `SwingKinematics`
(`app/src/metrics/kinematics.ts`: racket-frame signals, contact reference,
forward start, anchor with its window statistics, attitude series).
Implementation `app/src/metrics/features.ts`, tests
`app/test/metrics/features.test.ts`.

**Screens.** Live: the latest utterance is the headline (correction title in
the UI language, English cue small; "Better", "That's it", "Good", or
"Counted" with the reason when silent), then Why / Change / Drill for a
correction, the focus of the stroke type with its confidence (p of the focus
fault) and what it is compared with (your usual stroke, n; reference limits),
baseline progress below 15 strokes, and the metrics in three groups with
± σ, faults marked and not-assessable values greyed with the reason. G50 is
shown as "Late acceleration (proxy)". Session: per stroke type the strokes
counted, top corrections, "Better"/"That's it" counts and the engine's focus
(`sessionCoachSummary`). Setup: the fixed pMin and the baseline counts, with
"Reset personal baseline", which stores `baselineResetAt` (settings version 3);
strokes received before it are no longer used for the baseline.

**Evidence status.** Every definition and threshold in this section is an
**engineering choice** (`DEFAULT_FEATURE_PARAMS`, `DEFAULT_UNCERTAINTY_PARAMS`).
The only evidence behind them is agreement with the simulator, whose truth is
built from the same idealised rigid-lever model; none has been validated on
recorded strokes or video, and none has a literature reference value yet. They
are measurement building blocks for later coaching rules, not rules.

Notation: t_c contact time (impact sample − ½, or the peak sample without an
impact), t_c⁻ the last pre-impact sample, ω⊥ = hypot(ωy, ωz), θ tip
elevation, φ hitting-face normal elevation, γ swing path. Times in ms.

### Phase timeline (`features.phases`)

Times are ms from the first capture sample.

| Event | Definition | Null when |
| --- | --- | --- |
| `readyEndMs` | First sample after the last ≥ 0.3 s standstill (‖ω‖ < 0.5 rad/s) before the forward swing (same as the preparation start) | no such standstill in the capture |
| `backswingStartMs` | First sample after the ready end with ‖ω‖ ≥ max(0.5 rad/s, 0.3 × largest ‖ω‖ before the forward start) (version 5, see "Signal path v2") | the racket already turns that fast at the first sample |
| `forwardStartMs` | Start of the active phase (ω⊥ > 15 % of peak) | — |
| `contactMs`, `contactSample` | t_c, and the sample t_c⁻ that kinematics are read from | — |
| `followEndMs` | First sample after contact with ω⊥ < 0.3 · ω⊥(t_c⁻) | the capture ends first |
| `recoveryEndMs` | Start of the first run of ≥ 0.2 s with ‖ω‖ < 0.5 rad/s after the follow-through end | the capture ends first |
| `list` | Labelled phases preparation → follow-through (version 5, see "Signal path v2", "Stroke phases") | — |

### Features

| Feature | Definition | Null when |
| --- | --- | --- |
| `takebackTurnDeg` | \|∫ (q ω)·ẑ dt\| from `readyEnd` (or the anchor sample) to forward start: rotation about the world vertical | no usable attitude |
| `takebackTimeMs` | t_c − readyEnd (equals `preparationTimeMs`) | no ready position |
| `takebackTipDeg`, `takebackFaceDeg` | θ and φ at forward start | no usable attitude |
| `lateGainFraction` | G50 = 1 − ω⊥(t_c − 50 ms) / ω⊥(t_c⁻), ω⊥ interpolated linearly. Positive = still accelerating into contact; negative = slowing down | no impact, or gyro clipped in the forward swing |
| `forwardSwingMs` | t_c − forward start | — |
| `hitchCount` | Local minima of ω⊥ in [forward start, t_c⁻] more than 15 % below the running maximum. Hysteresis: after a counted dip ω⊥ must climb back by the same margin before another counts, so noise on one dip's floor is not counted twice | — |
| `contactStabilityDps` | Mean over the 3 pre-impact samples of \|dφ/dt\| + \|ωx\|, deg/s | contact angles withheld |
| `brushAngleDeg` | γ − φ at contact | contact angles withheld |
| `brakingTimeMs` | follow-through end − t_c | no follow-through end |
| `finishTipDeg` | θ at the follow-through end | no follow-through end or no usable attitude |
| `recoveryMs` | recovery end − t_c | no recovery end |

"Usable attitude" at an event: an anchor exists, at most
`maxSaturatedSamples` (1 reference sample since analysis version 5; 6 before)
gyro samples clipped without reconstruction between the anchor and that
event, and no data is missing in between (see "Signal path v2"). This is per event, so take-back angles of a serve stay available when
clipping near contact withholds the contact angles. Contact angles themselves
keep the existing rule (`attitudeReliable`).

### Serve features (`features.serve`, overheads only)

| Feature | Definition |
| --- | --- |
| `dropTipDeg`, `dropToContactMs` | Lowest θ in [readyEnd (or anchor), t_c⁻] (the back-scratch), and t_c minus its sample |
| `trophyTipDeg` | θ at the slowest sample (min ‖ω‖) in the 0.8 s before the drop. The window starts no earlier than `readyEnd`, otherwise the ready position's standstill would always win (engineering choice) |
| `rollPeakDps`, `rollPeakOffsetMs` | ωx of largest magnitude over [t_c − 50 ms, t_c⁻] ∪ [impact + 2, t_c + 50 ms] (signed: the sign tells pronation from supination for a given grip) and its time relative to t_c |
| `rollAngleDeg` | ∫ ωx dt over [impact + 2, t_c + 100 ms] (piecewise-linear interpolant); null when the capture ends sooner |
| `rollSaturated` | Any clipped gyro sample in [t_c − 50 ms, t_c + 100 ms]: roll peak and angle are then lower bounds |
| `contactTipDeg`, `contactTipReliable` | θ at t_c from the classification attitude, carried forward to t_c by rotation (below); given even when the displayed angles are withheld for clipping, with `contactTipReliable = false` and σ null |

**Impact jolt (analysis version 4).** An off-centre hit jolts the roll rate
at the impact sample and can ring into the next one (the simulator assumes
9 rad/s at the impact sample). Both samples are excluded: the roll peak is
searched before contact and from the second sample after the impact on, and
the roll angle is integrated from that sample (`rollJoltSamples = 2`,
engineering choice). The angle therefore misses the roll of the first
≈ 15 ms after contact; it is a personal-trend measure, not an absolute
pronation angle. Without a detected impact the windows are unchanged
(nothing to exclude). In simulation a −40 rad/s jolt leaves peak, offset and
angle unchanged.

**Overhead contact tip (analysis version 4).** At contact a serve's tip is
near the top of its arc, where the linear half-sample angle extrapolation
overshoots. For overheads `tipElevationDeg` and `contactTipDeg` instead carry
the attitude of the last pre-impact sample forward by the remaining fraction
of a sample, with the body rate extrapolated linearly to the middle of that
step (`overheadContactTipDeg`). Roll about the long axis does not move the
tip, so the roll leak that rules this out for the swing path does not apply.
On the simulated serve (30 rad/s, tip 70°) the errors were: linear +3.0°,
no extrapolation −2.0°, quadratic through the last three samples +1.7°,
rotation −0.3°; over tips of 50–80° at 24–34 rad/s the rotation stayed within
≈ 1.5° (2° at the extreme 80° tip), while the quadratic reached 4.5°.
Classification (`> 35°`) still uses the linear value.

### Uncertainty (`features.sigma`)

`app/src/metrics/uncertainty.ts`. 1-σ per feature, degrees for angles, ms for
times, m/s for head speed. Null means not assessable: the feature is
unavailable, more than `maxSaturatedSamples` gyro samples clipped without
reconstruction between the anchor and the event, or the stroke has a
`signalGap` (then every σ is null). Terms are combined as a root-sum-square.

| Term | Model | Basis |
| --- | --- | --- |
| Anchor σ_anchor | max(σ_noise, √(2 e_g)/3) rad. σ_noise = mean per-axis std of the window / √N (g ≈ rad). e_g = \|‖ā‖ − 1 g\|: a steady perpendicular acceleration a_p gives e_g ≈ a_p²/2 and a tilt ≈ a_p ≈ √(2 e_g); that bound is treated as 3σ | geometry (exact); the 3σ reading is an engineering choice |
| Drift σ_drift | b · Δt, b = max(1 deg/s, measured residual) residual gyro bias (calibration residual + temperature), Δt from anchor to event. The measured residual is ‖mean ω‖ over the stillest anchor-length window in the 0.5 s up to the anchor (version 5) | 1 deg/s: engineering assumption, to be measured; the residual estimate is an upper bound (hand motion adds to it) |
| Reconstruction | 0.3 × the rotation the gyro reconstruction added between anchor and event (version 5) | engineering choice, see "Signal path v2" |
| Contact timing | \|dx/dt\| · T_s/√12 · ½ for angles at contact (rate by finite difference of the two pre-impact samples; ½ because the half-sample extrapolation removes part of the quantisation error). 0 without an impact (the reference is the peak sample itself) | uniform quantisation (exact); the ½ is an engineering choice |
| Timing features | T_s/√12 ≈ 2.8 ms at 104 Hz (0.7 ms at 416 Hz); `peakSpeedOffsetMs` adds (reconstructed run containing the peak)/√12 | uniform quantisation; the run term is an engineering choice |
| Model | swing path + 3° (hand translation the lever model cannot see: ≈ 6–7° at 3 m/s of hand speed in simulation, `simulatorRealism.test.ts`); head speed 15 % relative (lever and centre of rotation unknown) | engineering choices |

Combinations: brush angle = RSS of face and path σ (treats them as
independent, which overestimates the shared anchor tilt). Take-back turn = RSS
of b · (interval length) and σ_anchor · (rotation path of the interval), since
a tilt δ mixes at most δ of every horizontal rotation into the vertical
component. Head speed and `peakSpeedOffsetMs` σ are null when the gyro clipped
in the forward swing.

Checked in simulation: σ grows with the anchor's gravity error and with the
time since the anchor; with a steady 0.2 g sideways push during the ready
position the face error stays below 3σ. Not yet checked: whether the σ match
the scatter of real repeated strokes.

Known gap: the contact extrapolation of groundstroke angles is linear, so an
angle at an extremum at contact is biased and its σ (from the rate) does not
cover it. For overheads the tip is carried forward by rotation instead (see
"Overhead contact tip" above).

## Coaching engine

What is said after a stroke comes from three pure steps (analysis version 4):
element catalogue and assessment (`app/src/elements/`), personal baseline and
coach (`app/src/coach/`). The controller wires them (below). The fixed rule
set of the next section is still evaluated (`analyzeCapture(...).cue`) and its
limits are the population limits of the catalogue, but it no longer decides
what is spoken.

### Element catalogue (`elements/catalog.ts`)

One or more entries per correction id (`coaching/corrections.ts`). An entry
names the metric (getter on `StrokeMetrics` / `features`), its σ (from
`features.sigma`, or an explicit engineering value), the fault side
(`below` = too little, `above` = too much; two-sided faults have two
entries), the strokes, swing sizes and styles it applies to, the population
limit P, the weight w and the noise floor s_min.

| Entry | Metric | Fault | P | w | s_min |
| --- | --- | --- | --- | --- | --- |
| face-open / face-closed (drive) | `faceTiltDeg` | above / below | 0° / −30° | 1.0 | 3° |
| slice-face-closed (slice) | `faceTiltDeg` | below | 0° | 1.0 | 3° |
| slice-chop (slice) | `swingPathDeg` | below | −35° | 0.9 | 3.5° |
| path-flat / path-steep (drive) | `swingPathDeg` | below / above | 12° / 55° | 0.9 | 3.5° |
| unstable-contact | `contactStabilityDps` | above | — | 1.0 | 50 deg/s |
| accelerated-early (drive) | `peakSpeedOffsetMs` | below | −40 ms | 0.8 | 10 ms |
| hitch | `backswingPauseMs` | above | 200 ms | 0.8 | 30 ms |
| hitch (count) | `hitchCount` | above | — | 0.8 | 0.25 |
| stiff-arm (drive) | `lateGainFraction` (G50) | below | — | 0.5 | 0.05 |
| no-racket-drop (drive) | `racketDropDeg` | above | −15° | 0.7 | 4° |
| open-takeback (drive) | `faceAtDropDeg` | above | 20° | 0.6 | 4° |
| high-takeback | `takebackTipDeg` | above | — | 0.6 | 4° |
| late-preparation | `takebackTimeMs` | below | — | 0.4 | 30 ms |
| small-turn | `takebackTurnDeg` | below | — | 0.4 | 4° |
| short-finish | `followThroughArcDeg` / `brakingTimeMs` | below | 120° / — | 0.5 | 4° / 30 ms |
| slow-recovery | `recoveryMs` | above | — | 0.3 | 30 ms |
| serve-no-drop | `serve.dropTipDeg` | above | — | 0.7 | 4° |
| serve-low-contact | `serve.contactTipDeg` (only when `contactTipReliable`) | below | — | 0.6 | 4° |
| serve-no-pronation | \|`serve.rollAngleDeg`\| (never when `rollSaturated`) | below | — | 0.5 | 8° |
| serve-accelerated-early | `peakSpeedOffsetMs` | below | — | 0.8 | 10 ms |
| serve-hitch | `hitchCount` | above | — | 0.8 | 0.25 |
| serve-short-finish | `brakingTimeMs` / `followThroughArcDeg` | below | — | 0.5 | 30 ms / 4° |

Groundstroke entries apply to full forehands and backhands, serve entries to
full overheads. Population limits are the exported constants of
`defaultRules.ts` (same values, same sources as the rule table below); "—"
means no literature or existing heuristic limit, so only the personal
baseline can fire the entry. **Backhands:** only the face limits (face-open,
face-closed, slice-face-closed) apply as population limits; every other
backhand element is personal-baseline only, because the published values are
for forehands. **Serves:** personal-baseline only (no published racket-level
serve values, see the rule section). "Loosen the wrist" now reads G50 against
the personal band; the cue and its "indirect proxy" wording are unchanged.

**Styles.** Face, path, take-back drop/face/height and contact-stability
entries need a known drive/slice style and keep a baseline per style. Timing
and rotation entries (hitch, preparation, turn, finish, recovery, all serve
entries) also apply when the style is unknown (no attitude anchor) and share
one baseline across styles. Hence without an anchor no angle cue can fire,
but a timing cue (e.g. "Keep the swing flowing") can; the old rule engine
gave such strokes "No reading".

**Weights and noise floors.** w: face and contact stability 1.0, path 0.9,
timing/acceleration/hitch 0.8, racket drop (also serve) 0.7, take-back
height/face and serve contact height 0.6, stiff-arm, serve roll and finish
0.5, preparation time/turn 0.4, recovery 0.3. s_min for face (3°) and path
(3.5°) come from the within-player SDs of advanced players (Knudson &
Blackwell 2005: face 2.8°, path 3.4°, speed 1.5 m/s; no element uses head
speed yet); all other
s_min values are engineering choices (angles 4°, timing 10 ms, durations
30 ms, G50 0.05, contact stability 50 deg/s, hitch count 0.25 so that one
extra dip fires, roll angle 8° ≈ a 150 deg/s roll-rate floor over the
≈ 50 ms roll peak).

**Explicit σ** (engineering choices, no `features.sigma` key): contact
stability 15 deg/s, G50 0.02, hitch count 0.25, follow-through arc 4°, roll
angle 3°, backswing pause √2 · T_s/√12 (two quantised edges).

### Assessment (`elements/assess.ts`)

`assessStroke(metrics, baseline, config) → StrokeAssessment`, per element:
value, σ, band actually used and its source, d, p, status, score.

- Without ball contact every element is not assessable (`no-contact`).
  Other reasons: `wrong-stroke` (type, size or style rules it out),
  `no-value`, `no-sigma` (e.g. strokes analysed before version 3, or an
  attitude not trusted at the event), `saturated` (clipped serve roll,
  unreliable serve contact tip), `no-baseline` (no P and no active baseline).
- **Band.** No active baseline: P alone (source `population`). Active
  baseline (median m, spread s): the personal bound m − k·s (`below`) or
  m + k·s (`above`), k = 2; with a P as well, the tighter of P and the
  personal bound (`combined`), except when m itself is beyond P (a habitual
  clear fault), then P alone (`population`). Without P: `personal`.
- d = distance outside the band (≥ 0), p = Φ(d/σ) (probability that the true
  value lies outside), Φ via erf (Abramowitz & Stegun 7.1.26, |error| ≤
  1.5 · 10⁻⁷, `math/stats.ts`).
- **Fault** when d > 0 and p ≥ pMin = 0.8. score = w · min(d/s, 3) · p with
  s the personal spread, or s_min without a baseline; 0 for non-faults.

### Personal baseline (`coach/baseline.ts`)

Key: stroke type × swing style (`any` for style-free entries) × swing size ×
metric. Per key the newest 60 values; median m and s = max(1.4826 · MAD,
s_min); active from n ≥ 15. Built at session start from the 600 most recent
strokes across sessions (`Repository.recentStrokes`, index `byReceivedAt`),
then updated after every stroke (the stroke is judged first, then added).

Only strokes with ball contact contribute, and only values that could be
assessed (present, not a clipped roll, a reliable serve contact tip).
Records older than version 3 have no features and contribute only their
metrics; serve roll angle and contact tip need version 4 (`minAnalysisVersion`)
because their definition changed. Faulty strokes are **included**: the median
is robust to a minority of faults, and excluding them would pull the baseline
towards whatever band is current. `buildBaseline` takes an optional filter as
the hook for future outcome tags (e.g. only balls that landed in).

### Coach (`coach/coachEngine.ts`)

`coachStep(state, assessment, config) → { state, utterance }`, utterance kind
`correction | better | keep-it | good | silent`, with the spoken English
phrase (from `CORRECTIONS` / `FEEDBACK_PHRASES`, empty when silent) and a
machine-readable reason. Elements of one correction (e.g. the two hitch
measures) are merged; the focus is a correction id.

- One focus per stroke type (forehand, backhand and serve independently).
- No focus: the highest-scoring fault becomes the focus and is spoken. No
  faults: `good`, spoken ("Good") only with `speakGood`. Nothing assessable:
  silent.
- Focus still at fault: "Better" when d_prev − d_now ≥ √(σ_prev² + σ_now²)
  (the improvement exceeds measurement noise), otherwise its cue again.
- Focus ok: "That's it" on the first ok stroke; after 3 ok strokes in a row
  the focus is cleared (and that stroke is coached as without a focus).
- A different fault replaces the focus only with score ≥ 2 × the focus
  fault's current score (its last fault score while it is ok or unassessable).
- Focus not assessable: silent, focus kept; cleared after 5 such strokes.
- Shadow swings and misses: silent, state unchanged.
- The same phrase is said at most 3 times in a row, then 2 strokes are silent
  (silent strokes do not break the run).

**Controller.** Signals: `baseline`, `baselineLoading`, `baselineCounts`
(strokes with contact per type), `coachState`, `focus` (per stroke type),
`assessment` and `utterance` of the latest stroke. In drill mode
`utterance.spoken` is said; in rally mode everything is computed and stored
but nothing is said. Each stroke record stores `coach: { utterance,
correctionId, focus }` and keeps the legacy `cue` for the session report and
export: the stroke's verdict, so a "Better" or a silenced repeat is still a
fix of the focus, "That's it"/good strokes are good, strokes without contact
or with nothing applicable yet (e.g. serves before a baseline) are
"Counted", and strokes with data missing are "No reading".

**Evidence status.** The engine's structure follows the motor-learning notes
in [research/coaching-engine.md](research/coaching-engine.md) (bandwidth
feedback, one cue at a time); pMin, k, the window sizes, the repeat limits,
the weights and all s_min except face/path are engineering choices to be
tuned on recorded sessions.

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

Only one cue is spoken per stroke; which one is decided by the coaching
engine above, using these limits as population limits.

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

## Signal path v2

Analysis version 5. Everything between `RawCapture` and the metrics is ready
for protocol v2 (higher rates, per-sample timestamps, lost samples, capture
header with ranges) while v1 captures keep working. The BLE protocol itself
is not part of this; only the fields it may deliver are.

Order of the steps (`app/src/metrics/kinematics.ts`, step 0):

1. `toImuSeries` (`processing/units.ts`): counts → SI with the configured
   ranges, saturation flags, timestamps passed on.
2. First contact pass on the native samples taken as uniform, without
   reconstruction: where is the ball impact?
3. `conditionSeries` (`processing/condition.ts`): gyro clipping
   reconstruction on the native samples at their true times
   (`processing/declip.ts`), then resampling onto the uniform nominal grid
   (`processing/timebase.ts`). Neither may straddle the contact found in
   step 2 (a "barrier").
4. Contact located again on the result. If only now an impact shows (the
   reconstruction revealed it), step 3 is repeated once with it as barrier,
   so no reconstruction bridges the impact it revealed.
5. The existing pipeline (racket frame, segmentation, attitude, metrics,
   features, σ), with the rate-agnostic and gap rules below.

**Evidence status.** Facts from the LSM6DS3TR-C datasheet are marked
*datasheet*; everything else is an **engineering choice** checked only
against the simulator (`app/src/simulation/swingModel.ts`), whose truth uses
the same idealised rigid-lever model. Nothing here has been validated on
recorded strokes.

### Datasheet facts (LSM6DS3TR-C, Table 3)

| Quantity | Value |
| --- | --- |
| Gyro sensitivity at ±125 / 250 / 500 / 1000 / 2000 dps | 4.375 / 8.75 / 17.5 / 35 / 70 mdps/LSB |
| Accel sensitivity at ±2 / 4 / 8 / 16 g | 0.061 / 0.122 / 0.244 / 0.488 mg/LSB |
| Gyro rate noise density (high-performance mode) | 5 mdps/√Hz, independent of ODR and range |
| Accel noise density (high-performance mode) | 90 µg/√Hz at ±2–8 g, 130 µg/√Hz at ±16 g |
| Gyro zero-rate level | ±3 dps typical (characterisation, not production-tested) |

Derived from these: the nominal gyro full scale is 28571 counts at every
range (range / sensitivity), and the accelerometer's nominal full scale fills
the int16 range at every range. The timestamp resolution (25 µs/LSB) and the
counter width the firmware forwards come from the v2 protocol design and are
to be confirmed there.

### Capture fields (`RawCapture`, `ImuSeries`)

All new fields are optional; absent means v1 behaviour.

| Field | Meaning | Default |
| --- | --- | --- |
| `sampleTimesUs` | Per-sample IMU timestamps, µs, monotonic modulo `sampleTimesWrapUs` | uniform at `sampleRateHz` |
| `sampleTimesWrapUs` | Timestamp wrap modulus, µs | 2³² (uint32 µs) |
| `gyroRangeDps`, `accelRangeG` | Configured full scales; the datasheet sensitivity of the range replaces the header's per-LSB value | per-LSB header values (v1: ±2000 dps, ±16 g) |
| `filter`, `temperatureC`, `firmwareVersion` | Provenance; not used by the analysis yet | — |
| `droppedSamples` | Samples the firmware knows were lost | 0 |

An unsupported range value or a timestamp count that does not match the
samples throws (the controller logs "Analysis failed").

### Units and saturation

- Gyro clip threshold: 0.98 × nominal full-scale counts = 28000 counts at
  every range (1960 dps at ±2000 dps). *Engineering choice* (unchanged value
  at ±2000 dps): the true clip point between nominal full scale and the int16
  limit is unspecified; the threshold may flag a few unclipped samples, never
  miss a clipped one.
- Accelerometer clip threshold: |counts| ≥ 32767 − 64 at every range.
  *Engineering choice* for the margin.
- `ImuSeries.gyroClipRadPerS` carries the per-axis threshold to the
  reconstruction.

### Timebase (`processing/timebase.ts`)

With timestamps:

- **Unwrap**: every interval is taken modulo the wrap; intervals must be
  shorter than one wrap period.
- **Rate**: the regular interval is the median interval (robust against
  gaps); if more than half the intervals are gaps, the nominal interval is
  used. It is refined over the capture as span / (intervals + missing
  samples) when that agrees within 2 %. Reported as `measuredRateHz`.
- **Gaps**: an interval longer than 1.5 × the regular interval holds
  round(interval / regular) − 1 missing samples (`maxGapSamples`).
- **Jitter**: RMS deviation of the regular intervals (`jitterUs`); 25 µs
  timestamp rounding alone gives ≈ 10 µs.
- **Resampling** onto t_k = t_0 + k / f_nominal by linear interpolation of
  accel and gyro. Missing stretches up to 10 ms (`maxInterpolatedGapS`: one
  sample at 104 Hz, four at 416 Hz) are bridged and the synthesised samples
  flagged `interpolated` (`interpolatedSamples`); longer ones are flagged
  `gap` (filled linearly only to keep arrays continuous, `gapSamples`).
  Saturation and reconstruction flags carry over from every input sample with
  interpolation weight ≥ 0.1. A grid point between the two native samples
  around a barrier (contact) is extrapolated from the two samples on its own
  side, so no grid sample mixes the racket before and after the impact
  (without this, a 5 % clock error cost 20 % of head speed in simulation).
- A clock error (true rate ≠ header rate) is thereby corrected: times come
  from the timestamps.

Without timestamps the series is used as is (uniform at the header rate). If
`droppedSamples` > 0, the losses cannot be located and every sample is
flagged `gap`.

Engineering choices: gap factor 1.5, 10 ms interpolation limit, flag weight
0.1. `MetricQuality.timebase` reports `timestamped`, `measuredRateHz`,
`maxGapSamples`, `jitterUs`, `interpolatedSamples`, `gapSamples`,
`droppedSamples`.

### Gaps and withholding

- `quality.signalGap` is set when a `gap` sample lies between the ready end
  (or the capture start) and the end of the contact search, or an
  interpolated sample lies within ±2 reference intervals of the contact
  reading (anywhere in the ±80 ms search window when no impact was found: the
  missing sample may have been the impact). Then the stroke is **not rated**
  (`isRateable`, element reason `signal-gap`, no baseline contribution, no
  head-speed statistic), every σ is null, the contact angles,
  `preparationTimeMs`, `peakSpeedOffsetMs`, `peakAccelerationOffsetMs` and G50
  are withheld.
- Attitude at an event is assessable only if no `gap` lies between the
  anchor window and the event; anchor windows never contain gap samples.
- Segmentation events (ready end, follow-through end, recovery end) found
  within one sample of a gap are reported as unknown (null).
- Without timestamps, samples lost without a `droppedSamples` count are
  invisible: the remaining samples are taken as consecutive, durations shrink
  and integrated angles change. This is the main reason v2 sends timestamps.

### Gyro clipping reconstruction (`processing/declip.ts`)

Per sensor axis, each run of clipped samples (|ω| ≥ clip level, same sign) is
bridged by a curve through the unclipped samples on both sides:

- **Model**: least-squares polynomial in ln|ω| over the support: cubic when
  ≥ 3 support samples exist on each side (follows the asymmetric peak of a
  swing, faster rise than fall), else a parabola (exact for a Gaussian peak).
  In ln|ω| the curve stays positive and does not run away on a short support.
  The reconstructed value is max(clip level, curve); the peak is the curve's
  maximum over the blind interval.
- **Support**: 30 ms per side (≥ 2 samples), contiguous, unclipped, same sign,
  no missing samples, not across a barrier. If the full support fails a check
  it is retried with fewer samples per side, nearest first, down to 2 (a step
  at the far end of the support then drops out).
- **Refusals** (run stays clipped, flagged unrecovered): run longer than
  100 ms (`maxRunS`); too little support; maximum not strictly inside the
  run; curve below the clip level inside the run or RMS residual > 0.03 in
  ln|ω| (≈ 3 %; catches a ball impact inside the support); peak > 1.6 × clip
  level; a barrier inside the run.
- **Never** applied to the accelerometer: impact transients and frame
  vibration are not smooth.

*Engineering choices*: all the numbers above. `maxRunS` is 100 ms rather
than the 25 ms first proposed: with the swing shapes of the simulator
(rise σ 50–90 ms) a 25 ms limit admits only peaks within ≈ 1 % of full scale,
and the fit error stayed ≤ 6 % up to 90 ms plateaus on smooth simulated peaks.
Real peaks are not Gaussian; this must be checked against a ±2000 dps
recording of the same strokes made at a higher range (bring-up).

Use in the analysis:

- `gyroSaturated` (per sample) still marks every clipped sample; the series
  also carries `gyroReconstructed` and `gyroUnrecovered` (clipped, not
  reconstructed).
- Head speed, peak timing and the impact search use the reconstructed rate.
  `quality.gyroSaturated` (speed is a lower bound, timing withheld) is now set
  only for **unreconstructed** clipping between forward start and contact;
  `quality.gyroReconstructed` / `reconstructedSamples` flag the rest.
- Attitude: `maxSaturatedSamples` counts only unreconstructed samples and is
  1 reference sample (was 6 counting all clipped samples): on the butt-cap
  swing at 42 rad/s, 6 unreconstructed samples (c. 10 % above full scale) cost
  ≈ 8° of face tilt, not the ≈ 1° measured on the earlier test swing.
- σ model (*engineering choice*): a reconstructed rate carries 0.3 × the part
  it added above the clipped value (head speed: RSS with the 15 % model term);
  attitude angles add 0.3 × the rotation the reconstruction added between
  anchor and event; `peakSpeedOffsetMs` adds (length of the reconstructed run
  containing the peak)/√12.

Simulation results (`app/test/processing/declip.test.ts`): asymmetric
Gaussian peaks of 2200–2800 dps clipped at 2000 dps, 104/208/416 Hz:
reconstructed peak within 5 % (typically +1…+5 %, i.e. ≤ 20 % of the excess),
peak time within one sample + 10 ms. Butt-cap shadow swings with rise σ
50 ms / fall σ 70 ms: head speed within 3 % (≤ 2 % observed) against −9 % to
−29 % without reconstruction, and inside 1σ; peak time within one sample
+ 5 ms; a peak 70 ms before a hit is timed within one sample + 6 ms where
timing was withheld before. A 210 ms plateau (default swing shape at
2800 dps) is refused: speed stays a flagged lower bound, timing withheld.

### Rate-agnostic analysis

The same stroke at 104, 208 and 416 Hz gives the same metrics within one
104 Hz sample for times, 1° for angles, 1 % for speed, 3° for arcs and the
same hitch count (`app/test/metrics/rateAgnostic.test.ts`). Audit of every
place that assumed 104 Hz or a fixed sample count:

| Place | Before | Now |
| --- | --- | --- |
| Impact jumps (`impactJumpThresholdG`, `impactGyroJumpRadPerS`) | sample-to-sample | over one reference interval (1/104 s = round(f_s/104) samples); parameters keep their v1 values and meaning |
| Steepest rise of ω⊥ (`peakAccelerationOffsetMs`) | central difference ±1 sample | ±1 reference interval |
| `maxSaturatedSamples` | samples | reference samples (×f_s/104) |
| Contact stability (`stabilitySamples` 3) | 3 samples | `stabilityWindowS` = 3/104 s |
| Roll jolt skip (`rollJoltSamples` 2) | 2 samples | `rollJoltS` = 2/104 s |
| Simulator impact transient / roll jolt | samples k, k+1 / sample k | 2/104 s and 1/104 s after contact (identical at 104 Hz) |
| Simulator noise | per-sample σ only | also a density (σ = density·√(f_s/2)) |
| Half-sample contact extrapolation, contact time k − ½ | sample units | unchanged: already a fraction of the actual interval (±½ sample = ±1.2 ms at 416 Hz) |
| Quiet windows, ready/recovery standstills, anchor window, impact search, G50, serve windows | seconds | unchanged |
| Hitch detection | relative dips with hysteresis | unchanged; rate-independent |

### Contact detection v2 (`processing/segmentation.ts`, `detectImpact`)

With the v2 options (all used by the analysis; without them `detectImpact`
behaves as in v1):

- **Span**: jumps over one reference interval.
- **Detrended gyro**: the gyro jump is the second difference
  Δω(i) − Δω(i − span): a ball impact is a step in rate, which both see in
  full, while the steep but smooth rise and fall of a fast swing cancel.
  Where the gyro is clipped without reconstruction only a drop in ‖ω‖ counts
  (clipping can understate a drop, never invent one).
- **Consistency** (`impactConfirmFraction` 0.25): an accelerometer-led
  candidate needs a gyro jump ≥ 0.25 × 7 rad/s nearby (the ball always takes
  rate away or jolts the racket), a gyro-led one an accelerometer jump
  ≥ 0.25 × 6 g, each when that channel is usable. This rejects frame
  vibration (accelerometer only) and ground bounces without a rate change.
- **Clipped accelerometer**: a jump involving a clipped sample is not trusted
  on its own (the part's overload behaviour is unspecified): it counts only
  when the gyro confirms it and never confirms a gyro candidate. (A strict
  "ignore" would lose every contact of the 1 m-lever test geometry, whose
  accelerometer clips through contact while the gyro sees only a 4.8 rad/s
  drop.)
- **Refractory window** (`impactRefractoryS` 30 ms): the onset is searched
  only within 30 ms before the strongest jump, so an earlier unrelated
  transient cannot become the onset.
- **Clipped plateau at the peak**: the search window is centred on the
  plateau and widened by half its length (its argmax is its first sample).
- **Ambiguity**: a candidate is rejected when the gyro was clipped without
  reconstruction within the refractory window before it and the
  accelerometer was already clipped before it: neither channel can place the
  onset. With no contact found but gyro clipping within the search window,
  a hit may be hidden, so the angles are withheld (`attitudeReliable`
  false); the stroke counts as no contact (not rated).

Tests (`app/test/processing/impact.test.ts`): shadow swings (24–38 rad/s, both
geometries, 104/208/416 Hz) give no contact; 5 g frame vibration gives none
in a shadow swing and the right sample in a hit; a 12 g ground bounce 4 or 20
samples after the peak is ignored; a hit with the accelerometer clipped up to
contact is found from the rate drop and jolt; both channels clipped → no
contact, no angles; a rail-to-rail flip of a clipped axis alone is not
contact; a strong unconfirmed transient 48 ms before the hit does not become
its onset.

### Stroke phases (`features.phases.list`)

`backswingStartMs` and a labelled list tiling the stroke, ms from the first
sample:

| Phase | From | To |
| --- | --- | --- |
| `preparation` | ready end (capture start if none: `truncatedStart`) | backswing start |
| `backswing` | backswing start (capture start if already turning: `truncatedStart`) | forward start |
| `forwardAcceleration` | forward start | t_c − 1 sample |
| `contact` | t_c − 1 sample | t_c + 1 sample |
| `followThrough` | t_c + 1 sample | follow-through end (capture end: `truncatedEnd`) |

**Backswing start** (*engineering choice*): the first sample at or after the
ready end at which ‖ω‖ reaches max(0.5 rad/s, 0.3 × the largest ‖ω‖ between
the ready end and the forward start) (`backswingStartFraction` 0.3). Before
it the racket only drifts out of the ready position (unit turn starting,
grip and stance settling); from it on it is being taken back. If the take-back
never exceeds the quiet band the backswing starts at the forward start; if
‖ω‖ is already above the threshold at the first sample, `backswingStartMs`
is null and the backswing is truncated. Phases of zero length are omitted.

Tests (`app/test/metrics/phases.test.ts`) evaluate the same definitions on
the simulator's continuous noise-free rate (`SwingTruth.omegaAt`, 0.2 ms
grid): with a 70° take-back turn and a backswing, ready end, backswing start,
forward start and follow-through end lie at the first sample at or after the
true crossing (within one sample + 1.5 ms) at 104 and 416 Hz; captures that
start during the take-back turn mark the preparation truncated, captures that
start inside the backswing begin with a truncated backswing.

### Robustness (`app/test/processing/robustness.test.ts`)

Butt-cap mount, backswing and 60° take-back turn, skewed mount calibration.
Rule: every value is withheld (null, σ null, or stroke not rated) or within
max(tolerance, 3σ) of the truth; a clipped speed is a lower bound. Measured
in simulation:

| Disturbance | Result |
| --- | --- |
| Gyro clipped at 2000 dps, 38–50 rad/s, 104/416 Hz | reconstructed within tolerance, or speed flagged as bound and angles/timing withheld |
| Accelerometer clipped through contact (30–34 rad/s) | contact sample exact, angles within 1° |
| 1, 3, 10 samples lost at random positions (v2, 104/208/416 Hz) | single losses outside the contact neighbourhood change nothing; losses of more than 10 ms inside the stroke or any loss where contact is read → not rated |
| Blocks of 1, 3, 10 samples around contact | never rated; never confidently wrong |
| 10 samples lost in the ready position | anchor moves; within 1° |
| Samples lost without timestamps (`droppedSamples` > 0) | nothing rated, no angles, every element `signal-gap` |
| White noise 2× / 5× the datasheet density | angles within 0.4°; face σ 0.96° → 1.18° → 1.46° (104 Hz) |
| Gyro bias step of 3 / 5 deg/s early in the ready position | σ grows ≥ 1.5×, error inside it |
| ±5 % clock error with timestamps | times within one 104 Hz sample, speed within 1 %, angles within 2° (tip ≤ 1.8°) |
| ±5 % clock error without timestamps (v1) | **not detectable**: every duration scales by true/reported rate (≈ ±5 %), take-back turn ≈ ±5 %, tip elevation ±2°, face < 0.3° |
| ±150 µs timestamp jitter | `jitterUs` ≈ 120; no measurable change |
| Timestamp wrap mid-capture | identical result |
| Mount rotated 2/5/10° about the long axis x | face tilt off by the full rotation; **σ does not include it** |
| … about the face normal z | tip elevation off by the full rotation; σ unchanged |
| … about y (in the string plane) | tip ≈ 0.2 × rotation, face < 1°, speed < 1 % |
| Calibration gyro bias wrong by 1/3/5 deg/s | face σ 1.0° → 2.7° → 4.5° (measured residual bias); errors ≤ 0.8° face, ≤ 3.4° tip, inside 1σ |

Known gaps: mount calibration errors are invisible to σ (no calibration term
exists; a rotation about x or z goes 1:1 into face or tip); the residual-bias
estimate includes slow hand motion (σ errs on the large side); a clock error
without timestamps and samples lost without a count are undetectable; when
both channels clip through contact the hit is reported as no contact; the
reconstruction and all thresholds are validated only in simulation.

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
  then gets "No reading" instead of a rating. Analysis version 5 reconstructs
  short clipped runs and tightens the rule to unreconstructed samples only
  (see "Signal path v2", which supersedes the 6-sample limit described here).
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
