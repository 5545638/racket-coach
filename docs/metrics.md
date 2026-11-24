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
   contact is ≈ bias × 1 s, i.e. well under 1° after calibration. Since
   analysis version 6 the residual bias is re-estimated on the still window
   ending at the anchor and removed for the whole capture when it passes its
   guards (see "Gyro bias re-estimation").

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
| Drift σ_drift | b · Δt, b = max(1 deg/s, measured residual) residual gyro bias (calibration residual + temperature), Δt from anchor to event. The measured residual is ‖mean ω‖ over the stillest anchor-length window in the 0.5 s up to the anchor (version 5), measured after the version 6 re-estimation (so ≈ 0 when it was applied, and b falls back to 1 deg/s) | 1 deg/s: engineering assumption, to be measured; the residual estimate is an upper bound (hand motion adds to it) |
| Reconstruction | 0.3 × the rotation the gyro reconstruction added between anchor and event (version 5) | engineering choice, see "Signal path v2" |
| Contact timing | \|dx/dt\| · T_s/√12 · ½ for angles at contact (rate by finite difference of the two pre-impact samples; ½ because the half-sample extrapolation removes part of the quantisation error). 0 without an impact (the reference is the peak sample itself) | uniform quantisation (exact); the ½ is an engineering choice |
| Timing features | T_s/√12 ≈ 2.8 ms at 104 Hz (0.7 ms at 416 Hz); `peakSpeedOffsetMs` adds (reconstructed run containing the peak)/√12. M416 splice (version 6): T_s is the measured gyro's interval at contact and peak only where the gyro was measured there (H section), the frame interval elsewhere; segmentation-based times (take-back, forward swing, braking, recovery) keep the frame interval, as do the contact-angle timing terms when contact lies outside H | uniform quantisation; the run term is an engineering choice |
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

- One focus per lane: stroke type × swing style (forehand, backhand and
  serve independently, drives and slices apart; unknown style = drive).
- No focus: the highest-scoring fault becomes the focus and is spoken. No
  faults: `good`, spoken ("Good") only with `speakGood`. Nothing assessable:
  silent.
- Focus still at fault: "Better" when it improved beyond measurement noise
  against the median of its previous faulty strokes (see "Adaptive coach"),
  otherwise its cue again.
- Focus inside its band on 2 strokes in a row: its reinforce phrase; after 3
  strokes inside the band (uncertain ones skipped) without a fault of it in
  between, the focus is cleared (and that stroke is coached as without a
  focus).
- A different fault replaces the focus only with score ≥ 2 × the focus
  fault's current score (its last fault score while it is ok or unassessable).
- Focus not assessable: silent, focus kept; cleared after 5 such strokes.
- Shadow swings and misses: silent, state unchanged.
- The same phrase (and, for a correction, the same ladder variant) is said at
  most 3 times in a row, then 2 strokes are silent (silent strokes do not
  break the run). A persistent fault no longer repeats one cue: it walks the
  phrase ladder (see "Adaptive coach").

**Controller.** Signals: `baseline`, `baselineLoading`, `baselineCounts`
(strokes with contact per type), `coachState`, `focus` (per stroke type),
`assessment`, `utterance` and `categories` of the latest stroke, plus the
adaptive signals of the next section. `coachStep` returns the decision
(`utterance`, stored in every mode) and separately the `speech` to say now
(null in match mode). Each stroke record stores `coach: { utterance,
correctionId, focus, mode, categories, phraseLevel, fatigueActive }` (the
last four absent on older records) and keeps the legacy `cue` for the
session report and export: the stroke's verdict, so a "Better", a silenced
repeat or a frozen focus is still a fix of the focus when it is at fault,
"That's it"/good strokes are good, strokes without contact or with nothing
applicable yet (e.g. serves before a baseline) are "Counted", and strokes
with data missing are "No reading".

**Evidence status.** The engine's structure follows the motor-learning notes
in [research/coaching-engine.md](research/coaching-engine.md) (bandwidth
feedback, one cue at a time); pMin, k, the window sizes, the repeat limits,
the weights and all s_min except face/path are engineering choices to be
tuned on recorded sessions.

## Adaptive coach

Pure, deterministic and on the device: no network and no AI in the stroke
loop. Modules in `app/src/coach/`: `profile.ts` (player profile),
`classify.ts` (deviation categories), `fatigue.ts` (fatigue detector),
`coachEngine.ts` (ladder, contradictions, modes), `plan.ts` (training plan),
`phrases.ts` (adapter over the correction texts). Every threshold below is
an engineering choice unless a source is named; all are to be tuned on
recorded sessions.

### Phrases (`coach/phrases.ts`)

The coach reads the correction texts only through this adapter, which falls
back when a richer field is missing, so it works with and without them:
`spokenVariants` [v0, v1, v2] → [spoken × 3]; `reinforce` → "That's it";
`learningSpoken` → the English `adjustment`; `weaknessLabel` → `title`;
FEEDBACK_PHRASES `overcorrected` / `consistency` / `fatigue` / `stuck` →
"A little less" / "Same swing every time" / "Take a short break" / "Try the
drill". `overcorrectedPhrase(fault)` reads `nowTooOpen` / `nowTooClosed` /
`nowTooFlat` / `nowTooSteep` ("Now too …") and falls back to "A little
less"; `stuckPhrase(id)` says "Try the *drillShort* drill" (`drillShort` ≤ 3
words, the phrase ≤ 6) and falls back to "Try the drill". Ladder variants are
told apart by index, so the schedule below is the same even while all three
variants are the same words.

Wording rules of the spoken texts (`coaching/corrections.ts`, tested):
variants ≤ 5 words (v0 of the legacy rule cues is pinned to defaultRules.ts
and may be longer), reinforce ≤ 6 words and describing the racket only — the
sensor cannot know where the ball went or how it felt, so no "ball", "net",
"in", "out", "felt", "floating" — and the learning sentence ≤ 12 words.

### Player profile (`coach/profile.ts`)

**Inputs** (Settings version 4): `dominantHand` right | left (default
right), `backhand` two-handed | one-handed (default two-handed),
`forehandStyle` topspin | flat | mixed (default mixed), `level` beginner |
intermediate | advanced (default intermediate). `coachingPolicy(inputs)`
turns them into the assessment config and two catalogues: the
profile-adjusted catalogue (all elements; the personal baseline and the
profile history use it) and the coached catalogue (assessment).

| Input | Changes |
| --- | --- |
| `dominantHand` | Serve pronation reads `max(0, sign · rollAngleDeg)` with sign +1 (right) / −1 (left); a roll in the wrong direction counts as no pronation (before: \|roll\|). Convention from the simulator: the right-handed serve pronates with a positive roll rate about racket +x (`rollRateRadPerS` +20 rad/s in the GOOD serve). A left-handed serve is the mirror image, and mirroring flips the long-axis component of the angular velocity (a pseudo-vector); calibrating on the other face only rotates the frame 180° about x, which keeps it. To be confirmed on the real sensor. The live view shows this signed, hand-corrected roll (negative = the wrong direction), and when ≥ 80 % of ≥ 10 serves in the session are negative it suggests checking the playing hand in Setup („Kontrolli mängivat kätt seadetes“). |
| `forehandStyle` flat | path-flat population limit 12° → 5° and population-only (the personal band may not tighten it): flat hitters legitimately swing flatter, so a flatter-than-usual drive is not a fault |
| `forehandStyle` topspin | path-steep 55° → 65°, population-only (topspin hitters legitimately swing steeper) |
| `level` beginner | only elements with weight ≥ 0.8 are coached (face, path, slice, contact stability, acceleration timing, hitch) and pMin = 0.85 |
| `level` intermediate / advanced | all elements, pMin = 0.8 (the behaviour before the profile) |
| `backhand` | stored and shown; no decision uses it yet (no racket-level limits that differ between one- and two-handed backhands) |

Hand and style change what the baseline holds, so changing either rebuilds
the baseline (and the profile history) at once.

**Derived** (pure functions over `StrokeRecord[]` and the session list):

- *Baseline*: the existing personal baseline (above).
- *Typical swing* per stroke type: medians over the last 200 strokes with
  contact of head speed, swing path, face, brush angle, forward-swing time,
  take-back turn and follow-through.
- *Weaknesses*: corrections whose fault rate over the last 200 rated strokes
  (all types) is ≥ 20 %, judged on ≥ 10 strokes there, and that showed in
  ≥ 2 sessions — counted from the per-session fault rates of every loaded
  session (rate ≥ 20 % on ≥ 5 judged strokes), so one long session cannot
  push the earlier ones out of the 200-stroke window. One session with ≥ 30
  judged strokes and ≥ 30 % faults is enough on its own; such a weakness is
  labelled *new* (first-session players). The rate is faults / strokes on which the correction was judged
  (ok or fault). Fatigue-related faults are not counted. Strokes stored with
  categories give every element's verdict; older records only their legacy
  cue (one fault at most, judged = every element that applies). Trend from
  per-session rates (sessions with ≥ 5 judged strokes): the latest against
  the mean of up to 3 earlier ones, ≤ −10 points improving, ≥ +10 worsening,
  else stable (also with fewer than 2 sessions).
- *Progress* per session (oldest first), per element: n (strokes with a
  value), fault rate (strokes with stored categories only, else null) and
  median value; per correction: fault rate. For charts.

The controller builds it at session start from the 600 most recent strokes
(`recentStrokes`, the same load as the baseline) and `listSessions`, and adds
each stroke with `addStrokeToProfile` (O(window) per stroke: arrays of at
most 200 values are copied; the current session's element values grow with
the session). A baseline reset does not erase the profile history.

### Deviation categories (`coach/classify.ts`)

Every applicable element of every stroke (elements that do not apply are
left out):

| Category | When |
| --- | --- |
| `technical-error` | fault (d > 0, p ≥ pMin) |
| `fatigue-related` | fault while the fatigue detector is active for the stroke type |
| `improvement` | the focus at fault but significantly better ("Better"), or the focus back inside its band |
| `uncertain` | outside the band with p < pMin, or inside but σ > s and less than σ inside the bound (cannot be told from a fault) |
| `variation` | inside the band (personal, or population without a baseline) |
| `not-assessable` | not judged (no contact, missing value or σ, no baseline …) |

Stored per stroke as `coach.categories: { counts, byElement }`.

### Fatigue (`coach/fatigue.ts`)

Per stroke type, within the session, over rated strokes (contact, no signal
gap, at least one element judged), compared like with like: separately per
swing size × swing style (unknown style = drive), the first 20 strokes of
that kind are the reference and the last 10 the rolling window. Checked once
the kind has ≥ 30 rated strokes **and** ≥ 15 minutes have passed since the
session start (or since the end of the last break).

- **Active** when the median head speed of the window is ≥ 8 % below the
  reference **and** the faults per stroke in the window are ≥ 2 × the
  reference rate, at least 0.3, and spread over ≥ 2 different elements.
  Slower alone is not fatigue: a deliberate control drill at lower speed
  (with its longer forward swing) has no extra faults. The forward-swing
  change is still read (`forwardSwingRise`) but decides nothing.
- Only a reading of the stroke's own kind changes the flag of the type.
- **Clears** when the speed drop is back below 4 % (half the threshold, so it
  does not flicker), or after a break of ≥ 3 minutes between strokes, which
  restarts **every** reference, window and count: the strokes after a break
  are a new warm-up and cannot be compared with the session's start.
- While active, coaching is frozen for at most 20 strokes of the type: no
  new focus, no ladder, no clearing; in learning and training "Take a short
  break" is said once and not again for 10 minutes (without timestamps: once
  per episode); faults are `fatigue-related`. After 20 frozen strokes normal
  coaching resumes even if the flag stays (faults are still categorised
  `fatigue-related`). When a hold ends, and after any ≥ 3-minute break, the
  focus' "Better" reference and sparse counter restart.
- **Sessions.** The controller starts a new session by itself when more than
  30 minutes pass between two strokes, or when the sensor (re)connects more
  than 30 minutes after the last stroke (`SESSION_GAP_MS`). A session without
  strokes never ends this way. Stored strokes and sessions are untouched; the
  new session gets a fresh coach and fatigue state, and the baseline and the
  profile are rebuilt from storage as at any session start.

### Phrase ladder and silence schedule (`coach/coachEngine.ts`)

Per focus the coach counts the corrections actually heard: `spokenCount`
(the ladder; reset only by the reinforce phrase) and `lifetimeSpoken` (never
reset while it is the focus). A persistent fault gets, on its faulty strokes:

| Faulty stroke on the focus | Said | Utterance |
| --- | --- | --- |
| 1, 2 | cue variant v_b | `correction`, level b |
| 3, 4 | v_(b+1) | `correction` |
| 5 | v_(b+2) | `correction` |
| 6 | "Try the *drill* drill" (e.g. "Try the brush-up drill", ≤ 6 words; "Try the drill" without a short drill name), once, only if the reinforce phrase was not heard for this focus | `stuck` |
| then every 3rd faulty stroke (9, 12, …) | "Better" if it is due (below), else the variants in turn from v_b | `correction` / `better` |
| the other strokes | — | `silent`, reason `ladder-sparse` |

Sparse mode starts when the ladder has run out (5 spoken corrections) or the
focus has had 10 spoken corrections in its lifetime, so a player whose
fault comes and goes cannot keep restarting the ladder.

b is 0 for a new focus, or the variant with the most "Better"s for this
correction in the player profile (`betterByLevel`; the controller passes it
as `preferredLevels`). Before sparse mode, "Better" replaces the cue on its
stroke and does not move the ladder.

- **"Better"**: the focus fault is compared with the median of its up to 5
  previous faulty strokes (same element, same band; the window restarts when
  either changes): median(d) − d_now ≥ √(median(σ)² + σ_now²). Said at most
  once per 3 strokes of the lane, and only when the focus cue was actually
  heard. It does **not** reset the ladder. In match mode an improvement is not
  added to the window, so it can still be said later.
- **Reinforce** (the correction's `reinforce` phrase, e.g. "Good. Keep that
  acceleration.", else "That's it"): only when the focus is inside its band
  (d = 0 and not `uncertain`) on 2 strokes in a row, once per ok run, and only
  when the focus cue was heard in a speaking mode. It resets the ladder (the
  count starts again, b becomes the variant last heard) and the "Better"
  window. The focus clears after 3 strokes inside the band without a fault of
  it in between; uncertain strokes neither count nor interrupt.
- The 3-in-a-row / 2-silent repeat limit still applies to every phrase, but
  for corrections it compares the ladder variant, so the ladder never trips it.

Example rates (tests, `scenarios.test.ts`): a noisy player with path ~ N(2°,
5°) against the 12° limit hears about a third of the strokes after the first
10 (before: 59 of 60); fault / ok / fault / ok hears less than a third and no
praise.

### Opposites, overcorrection, oscillation

Opposite pairs (same metric, other side): face-open ↔ face-closed, path-flat
↔ path-steep. slice-chop (slice path) and slice-face-closed (slice face) read
different metrics and are **not** opposite; high-takeback, no-racket-drop,
the timing and serve cues have no opposite element.

- **Overcorrection**: focus X and X's opposite at fault (p ≥ pMin): a phrase
  naming the fault that is there now — "Now too closed" / "Now too open"
  (face), "Now too steep" / "Now too flat" (path); "A little less" for a pair
  without one — once per episode (the focus' life), focus stays X. The next
  opposite fault (or the 3rd in a row while nothing is heard) switches the
  focus, and the opposite's own cue is said.
- **No contradiction**: a cue whose opposite was the focus **replaced** at
  most 5 strokes ago (by a switch or a bigger fault) gets the overcorrection
  phrase instead (reason `contradiction`, ladder not advanced), at most once
  per episode; then the real cue. A focus that was fixed and cleared does not
  block its opposite: a new opposite fault gets its own cue at once.
- **Soft conflicts** (different metrics whose cues can pull against each
  other): stiff-arm ↔ unstable-contact, small-turn ↔ high-takeback,
  short-finish ↔ high-takeback, serve-no-drop ↔ serve-hitch. A correction
  does not become the focus while its partner's cue was spoken in the previous
  5 strokes of the lane (silent, reason `soft-conflict`), unless it already is
  the focus. Their wording avoids the clash ("Smooth through the ball", not
  "Swing, don't flick", next to "Let the racket lag"; no "pause at the lowest
  point" in the serve-drop drill).
- **Oscillation**: when the faults of a pair switch sides ≥ 3 times in the
  last 6 strokes of the lane: "Same swing every time" (at most once per 10
  strokes of the lane) instead of either cue, silent otherwise; the focus
  bookkeeping (opposite streak, switch, distances) still applies.

### Modes

| Mode | Per stroke | Extra |
| --- | --- | --- |
| learning | as training; the **first** cue of a focus is followed by its one-sentence `learningSpoken` (≤ 12 words), in one utterance (the speaker cancels a running phrase), at most once per correction per session and only when the previous gap between strokes was ≥ 6 s (or there was none); otherwise the short cue | details on screen |
| training | one short phrase: the ladder, "Better", reinforce, the feedback phrases | |
| match | silent | a persistent major fault — the same correction in ≥ 5 of the last 8 rated strokes of a lane, mean p ≥ 0.9, weight ≥ 0.8 — is said (variant 0) only between points: once no stroke has come for 8 s after the previous stroke's `capture.receivedAt` (a timer the controller restarts on every stroke, `matchIdle`), and at most once per 10 minutes. Never praise, no fatigue phrase |

In match mode the coach still decides as if nothing were heard (focus,
categories, fatigue), so every mode stores the same decisions for the session
report. A change of mode forgets every focus, ladder and recent cue
(`withoutFocus`): a cue heard in one mode is not built on in another, and a
focus found in match mode was never heard. Disconnecting stops the match
timer and drops queued speech. Settings before version 4: drill → training,
rally → match.

### Final schedule and thresholds

All values are engineering choices, to be tuned on recorded sessions.

| Setting | Value |
| --- | --- |
| Lane | stroke type × swing style (unknown = drive) |
| Ladder | v_b, v_b, v_(b+1), v_(b+1), v_(b+2), "Try the … drill", then every 3rd faulty stroke |
| Sparse after | 5 ladder cues, or 10 cues in the focus' lifetime |
| "Better" | median of ≤ 5 previous focus distances, √(median σ² + σ²), ≤ 1 per 3 strokes, heard cue only, ladder not reset |
| Reinforce | 2 strokes inside the band in a row, once per ok run, heard cue only; resets the ladder |
| Focus cleared | 3 strokes inside the band (uncertain skipped); 5 not assessable |
| Replacement | other fault with ≥ 2 × the focus score |
| Overcorrection | specific phrase once per episode, then switch; 3 in a row when unheard |
| Contradiction window | 5 strokes after a replacement; soft conflicts 5 strokes after the partner's cue |
| Oscillation | ≥ 3 side switches in 6 strokes; "Same swing every time" ≤ 1 per 10 strokes |
| Repeat limit | 3 identical phrases, then 2 silent strokes |
| Fatigue | ≥ 30 strokes of the kind and ≥ 15 min; speed −8 % **and** faults ≥ 2 × early, ≥ 0.3/stroke, ≥ 2 elements; clears at −4 % or a 3-min break; hold ≤ 20 strokes; phrase ≤ 1 per 10 min |
| Break | ≥ 3 min between strokes: fatigue references, "Better" window and sparse counters restart |
| New session | > 30 min between strokes, or a (re)connect > 30 min after the last stroke |
| Learning sentence | first cue of a focus, once per correction per session, gap ≥ 6 s, ≤ 12 words |
| Match | ≥ 5 of 8, mean p ≥ 0.9, weight ≥ 0.8; after 8 s quiet; ≤ 1 per 10 min |

### Training plan (`coach/plan.ts`)

`buildPlan(profile, language)`: up to 2 weaknesses, worsening first, then by
weight × the latest session's fault rate (sessions with ≥ 5 judged strokes;
the window rate when there is none); each with the catalogue drill, 3 × 15
balls, the cue variant with the most "Better"s (stored per stroke as
`coach.phraseLevel`; variant 0 when none) and a success criterion: fault rate
on the next session below max(10 %, half the latest session's rate), rounded
up to 5 %. A weakness already below that target in its latest session gets
no plan item. Plus one
maintenance item (1 × 15 balls) for the correction whose per-session fault
rate fell most (≥ 10 points) from its first to its latest session, target:
no worse than now. `PlanEnhancer` is an optional asynchronous interface
(e.g. a future AI rewriting the explanations); it is not implemented and
never called in the stroke loop.

### Controller signals

`policy` (assessment config and catalogues from the inputs), `preferredLevels`
(per correction the variant with the most "Better"s, passed to the coach), `profile`
(inputs + baseline, typical swing, weaknesses, progress, "Better"s per
variant), `weaknesses`, `progress`, `plan`, `fatigue` / `fatigueActive`,
`categories` (latest stroke), `lastSpeech`, and `utterance` with the kinds
`correction | better | keep-it | good | silent | overcorrected | consistency
| fatigue | stuck`.

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
| Gyro bias step of 3 / 8 deg/s early in the ready position | 3: re-estimated and removed (version 6), errors < 0.5°, σ unchanged; 8 (above the 5 deg/s limit): kept, σ grows ≥ 1.5×, error inside it |
| ±5 % clock error with timestamps | times within one 104 Hz sample, speed within 1 %, angles within 2° (tip ≤ 1.8°) |
| ±5 % clock error without timestamps (v1) | **not detectable**: every duration scales by true/reported rate (≈ ±5 %), take-back turn ≈ ±5 %, tip elevation ±2°, face < 0.3° |
| ±150 µs timestamp jitter | `jitterUs` ≈ 120; no measurable change |
| Timestamp wrap mid-capture | identical result |
| Mount rotated 2/5/10° about the long axis x | face tilt off by the full rotation; **σ does not include it** |
| … about the face normal z | tip elevation off by the full rotation; σ unchanged |
| … about y (in the string plane) | tip ≈ 0.2 × rotation, face < 1°, speed < 1 % |
| Calibration gyro bias wrong by 1/3/5 deg/s | version 6: 1 and 3 deg/s are re-estimated (1.00 / 3.00 deg/s removed); the angles equal those of the correctly calibrated capture (face 0.31°, path 0.44°, tip 0.11° off truth), σ back at 0.96°. Without re-estimation (version 5) tip −0.77° / −2.10°, face σ 1.0° → 2.7°. 5 and 8 deg/s exceed the plausibility limit (measured residual > 5 deg/s): kept, face σ 4.5°, errors ≤ 0.8° face, ≤ 3.4° tip, inside 1σ |

Known gaps: mount calibration errors are invisible to σ (no calibration term
exists; a rotation about x or z goes 1:1 into face or tip); the residual-bias
estimate includes slow hand motion (σ errs on the large side); a clock error
without timestamps and samples lost without a count are undetectable; when
both channels clip through contact the hit is reported as no contact; the
reconstruction and all thresholds are validated only in simulation.

## v2 captures (analysis version 6)

Everything between a protocol v2 capture (docs/sensor-v2.md,
docs/ble-protocol.md) and the analysis input. Entry point:
`seriesFromCapture` (`processing/highRate.ts`), used by `analyzeCapture`
(`app/pipeline.ts`). v1 captures and v2 M104 captures go through
`toImuSeries` unchanged apart from the header mapping below. As in "Signal
path v2", every number not marked *datasheet* is an **engineering choice**
checked only in simulation.

### Header mapping (`processing/units.ts`)

| v2 field | Analysis input |
| --- | --- |
| `gyroMdpsPerLsb` | ±range: 70 → 2000 dps, 35 → 1000 dps (*datasheet* sensitivities that are integers; 4.375/8.75/17.5 cannot be sent as u16). Anything else **rejects the capture** (`CaptureRejectedError`, "Analysis failed" in the log); so does a value that contradicts an explicit `gyroRangeDps` |
| `accelUgPerLsb` | ±range: 61/122/244/488 → 2/4/8/16 g; unknown → rejected |
| `sampleTimesUs`, `framePeriodNs` | timestamps (timebase.ts) for M104; for M416 the true frame rate 1 / `framePeriodNs` sets the rate of the spliced series |
| `flags` b0 + b3 | the firmware drops the ring and any capture in progress on a FIFO reset, so the window starts right after the reset: data was lost **before the first sample** → the first sample is a `gap` (`lostBeforeStart`). A stroke whose ready position lies inside the window is unaffected; one without (capture start inside the stroke) is not rated |
| `flags` b3 without b0 | a reset at an unknown position inside the window: an unlocated loss → `droppedSamples` ≥ 1 → every sample `gap` (timebase.ts: losses the timestamps do not show are unlocated; v2 frame times come from one period and never show them) → not rated, no angles, no σ |
| `flags` b1 (gyro clipped) | the firmware checks every raw 416 Hz sample; the app checks the values it has. M416 frame means can hide a clipped sub-sample: with b1, a frame whose mean reaches 0.9 × the clip level (`FRAME_MEAN_CLIP_FRACTION`), or whose raw H sub-samples clipped, is `gyroSuspect` (treated as clipped and not reconstructable). If b1 is set and no sample can be located, every sample is suspect (angles withheld, speed a bound) |
| `flags` b2 (accel clipped) | A0 is raw, so the per-sample check is exact; b2 without a located sample (should not happen) marks every sample saturated |
| `temperatureC` | compared with the calibration's (below) |

A per-sample hit without the flag is kept: the flags can only add caution.

### M416 high-rate splice (`processing/highRate.ts`)

An M416 frame f carries A0 (accelerometer at the frame time), the rounded
mean of the four 416 Hz gyro samples G0…G3 (centred at f + 0.375 frame) and,
for frames peak − 15 … peak + 15, the raw G0…G3 at f + k/4. The analysis
cannot run at a variable rate, so the splice builds one uniform series on
t = f + k/4 at four times the true frame rate (416.7 Hz):

- **accelerometer**: linear between the A0 samples (`accelMeasured` at
  k = 0). Linear, not cubic: the impact is a step and a cubic rings around it;
- **gyro outside H**: the frame means as samples at f + 0.375, Catmull-Rom
  cubic between them (linear extrapolation at the capture ends);
- **gyro inside H**: the raw samples at their exact times (`gyroMeasured`).

The series carries no timestamps: the v2 frame times are derived from one
measured period, so it is already uniform; resampling it onto a nominal
416 Hz grid would blend the raw H samples and leave no grid point exactly on
an A0. If a capture's timestamps showed missing frames the splice is not
attempted (the frames are analysed as delivered).

**Cubic or linear?** Catmull-Rom is local (a step or a clipped run affects two
intervals each side) and exact for quadratics (error O(h³) against O(h²)
linear). In the comparison below it changed no metric by more than 0.05°
or 0.01 ms against linear interpolation: everything outside H lies ≥ 144 ms
from the peak, where the rate is smooth. Kept as the default for the rate
curve of the preparation phases.

**Contact onset with interpolated accelerometer** (`detectImpact`,
`accelMeasured`/`gyroMeasured`): an accelerometer jump counts only between
two measured samples (one frame apart); the interpolated ramp would put the
onset anywhere in the frame. The onset of an accelerometer-led contact then
only says "within the last frame"; where the gyro was measured over that
frame and shows the ball's step (≥ `impactConfirmFraction` of its threshold),
the onset moves to the first sub-sample whose gyro jump reaches half of the
largest one there. Without this the sensor-near-string-bed geometry read
speed up to 20 % low (the reading sample was already post-impact).

**σ and quality.** `quality.highRate` reports the measured gyro samples and
whether contact was read from measured gyro (`contactMeasured`). The contact
timing terms use the 416 Hz interval only where the gyro was measured at
contact (and the peak's only at the peak); events found in the interpolated
section keep the frame interval (Uncertainty table).

**Comparison** (`app/test/processing/highRate.test.ts`). Truth swings
simulated at 416.7 Hz with datasheet noise (130 µg/√Hz, 5 mdps/√Hz), contact
at 4 sub-frame offsets × 4 phases within the sample × 20 and 26 rad/s
(32 strokes per geometry), peak 20 ms before contact, 8 rad/s of roll;
captures built exactly as the firmware does (`simulation/firmwareCapture.ts`:
frame means `(ΣG + 2) >> 2`, H around the largest ‖G0‖², A0 decimation).
Errors against the simulator truth, mean / rms / max |error|:

Butt cap (contact found from the gyro):

| Metric | Truth sampled at 416.7 Hz | **M416 spliced** | M104 (every 4th sample) | M416 frame means only (no splice) |
| --- | --- | --- | --- | --- |
| Contact time, ms | −0.18 / 0.69 / 1.08 | **−0.18 / 0.69 / 1.08** | 2.23 / 3.55 / 6.73 | −0.78 / 8.71 / 21.5 |
| Peak timing, ms | 0.69 / 1.39 / 1.97 | **0.50 / 1.26 / 2.00** | 0.17 / 4.77 / 5.58 | −0.43 / 9.40 / 20.0 |
| Head speed, % | 0.10 / 0.11 / 0.18 | **0.10 / 0.12 / 0.18** | 0.33 / 0.38 / 0.61 | −7.3 / 11.6 / 24.5 |
| Face at contact, ° | −0.07 / 0.32 / 0.52 | **−0.08 / 0.34 / 0.63** | −0.97 / 1.67 / 3.23 | −3.1 / 6.2 / 13.4 |
| Path at contact, ° | −0.14 / 0.16 / 0.26 | **−0.15 / 0.18 / 0.30** | 0.12 / 0.22 / 0.37 | −1.8 / 2.7 / 6.0 |
| Tip at contact, ° | −0.25 / 0.46 / 0.90 | **−0.27 / 0.46 / 0.93** | 0.89 / 1.78 / 3.81 | 0.7 / 3.7 / 8.6 |

Sensor near the string bed (1 m lever, 40 g transient: contact led by the
accelerometer):

| Metric | Truth sampled at 416.7 Hz | **M416 spliced** | M104 | M416 frame means only |
| --- | --- | --- | --- | --- |
| Contact time, ms | −0.18 / 0.69 / 1.08 | **−0.18 / 0.69 / 1.08** | 2.23 / 3.55 / 6.73 | −0.78 / 8.02 / 21.5 |
| Peak timing, ms | 0.77 / 1.43 / 1.97 | **0.20 / 1.06 / 2.00** | 0.17 / 4.77 / 5.58 | −0.43 / 8.07 / 20.0 |
| Head speed, % | 0.10 / 0.11 / 0.17 | **0.10 / 0.11 / 0.17** | 0.23 / 0.30 / 0.51 | −7.7 / 11.0 / 19.1 |
| Face at contact, ° | 0.11 / 0.18 / 0.27 | **0.11 / 0.18 / 0.26** | 0.39 / 0.44 / 0.69 | 0.11 / 0.56 / 1.38 |
| Path at contact, ° | 0.12 / 0.19 / 0.28 | **0.11 / 0.18 / 0.27** | 0.50 / 0.55 / 0.84 | 0.12 / 0.73 / 1.83 |
| Tip at contact, ° | −0.46 / 0.59 / 0.99 | **−0.45 / 0.58 / 1.00** | 0.88 / 1.82 / 3.91 | 1.05 / 3.92 / 8.77 |

Reading: the splice matches an analysis of the true 416 Hz samples to within
0.1° and 0.2 ms, i.e. what the H section provides is all that matters at
contact. Against M104 it improves contact timing (max 6.7 → 1.1 ms), peak
timing (5.6 → 2.0 ms), face and tip (max 3.2–3.9° → ≤ 1°) and speed slightly.
**Path at contact (butt cap) does not improve** (rms 0.22° → 0.18°, within
the noise): the path is dominated by the rate direction, which changes
little within a frame. It is not worse either, so no metric falls back to
104 Hz. Analysing the M416 frame means alone — what the app did with M416
captures before version 6 — is much worse than M104: the mean of the frame
that contains the impact already carries part of the post-impact rate drop,
so contact is misplaced or missed (13 % of strokes) and speed reads up to
24 % low. With gyro clipping (38–44 rad/s at ±2000 dps on this swing shape)
every mode withholds timing and angles and flags speed as a bound: the
plateau is too long to reconstruct, with or without H.

Filters are not modelled (docs/sensor-v2.md: the real gyro bandwidth is
137 Hz in M416 and 33 Hz in M104; M104 would be smoother than shown).

### Gyro bias re-estimation (`processing/gyroBias.ts`)

On the still window ending at the attitude anchor the mean gyro rate (after
the calibration bias) is the residual bias. The window is the anchor's,
extended backwards while every sample rotates slower than 0.5 rad/s and is
unclipped and present, up to `biasWindowMaxS` 0.5 s. The estimate is removed
for the whole capture (everything is computed again with it added to the
calibration bias) only when all hold:

| Guard | Value | Why |
| --- | --- | --- |
| Window length | ≥ `biasWindowMinS` 0.1 s | too few samples to average |
| ‖residual‖ | ≤ `biasMaxDps` 5 deg/s | *datasheet*: zero-rate level ±3 dps typical, ±0.05 dps/°C; more is motion or a broken calibration (0 disables re-estimation) |
| Resolvable | 6σ of the gravity-direction noise over the half-window spacing ≤ `biasMaxUndetectedDps` 1 deg/s | otherwise the next test cannot see a slow rotation |
| Gravity steady | angle between the mean specific force of the two window halves ≤ ½ × the turn the gyro mean predicts (component ⊥ gravity) + 3σ | a real rotation turns gravity in the body frame; a bias does not |

σ of the direction noise: per-axis σ from sample-to-sample differences
(insensitive to a slow trend) / √(half-window samples) × √2.
`quality.gyroBiasCorrectionDps` reports the removed residual (0 when kept).
Then the measured-residual term of σ_drift (Uncertainty) is ≈ 0 and σ falls
back to the 1 deg/s model value.

Results (`robustness.test.ts`, `gyroBias.test.ts`): a calibration bias
wrong by 3 deg/s costs < 0.5° on every contact angle (identical to the
correctly calibrated capture) instead of 2.1° of tip elevation; a racket
turning at 0.3 rad/s in the window is rejected (implausible, and gravity
turned); a 2.9 deg/s rotation about a horizontal axis is rejected by the
gravity test while the same rate as bias of a still racket is accepted; an
80 ms window or 5 mg of hand tremor in a 120 ms window keep the calibration.
**Blind spot**: a steady rotation about the vertical leaves gravity unchanged
and is taken as bias up to 5 deg/s (≈ 5° over 1 s at worst).

### Temperature

The calibration stores the IMU temperature of its two static poses
(`MountCalibration.temperatureC`, v2 sensors: the captures' OUT_TEMP, else
the latest STATUS2). Each analysed capture reports
`quality.temperatureDeltaC` and `quality.temperatureWarning` (|Δ| >
`temperatureWarnC` 10 °C); Setup shows "Temperatuur on kalibreerimisest
muutunud, kalibreeri uuesti" / "Temperature has changed since calibration,
calibrate again" when the latest stroke's (else STATUS2's) temperature is that
far from the calibration's. OUT_TEMP is ±15 °C absolute (*datasheet*) but its
changes are what matter. The bias re-estimation above removes most of the
effect anyway; the warning covers captures where it cannot run.

### Raw data preservation

The stored `StrokeRecord.capture` is the complete `RawCapture` as assembled:
L section, H section (`gyroHr`), frame times, frame period, flags,
OUT_TEMP raw and °C, sensitivities, filter configuration, mode and firmware
version, plus the calibration snapshot and parameters. The JSON export
(`toJson`/`fromJson`, `app/export.ts`) writes samples and H as base64 and
timestamps as an array, and reads them back value for value;
`reanalyseStroke` (`app/pipeline.ts`) fills parameters added since the record
was stored with their defaults. Re-analysis from IndexedDB or from the export
reproduces the stored metrics exactly for v1 and v2 records
(`app/test/app/rawPreservation.test.ts`).

### End to end (`app/test/firmware/endToEndV2.test.ts`)

Simulated butt-cap stroke → LSM6DS3TR-C register model at 416 Hz (M416) →
the Espruino firmware → BLE with 10 % of notifications lost → app link
(NAK/resend, CRC) → assemblerV2 → splice and analysis → rule cue, element
assessment and coach. The delivered capture is bit-exact, analysis and coach
outputs are identical to a lossless run, face/path/tip are within 1.5° and
head speed within 1 % of the truth, peak timing within 5 ms.

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

## Session report and history (`coaching/strokeFacts.ts`, `consistency.ts`, `trainingReport.ts`, `ui/historyModel.ts`)

Everything is derived from stored stroke records, so any past session can be reported.

### Overall reading per stroke

Every stroke gets exactly one reading (the counts add up to the number of strokes, not of elements):
`correction` (the coach spoke a correction) > `fatigue` (no correction, faults exist and all were fatigue-related) >
`fault-silent` (a fault that was not spoken) > `uncertain` > `style` (all judged elements inside the band) >
`not-assessable`. Records without categories use their cue (fix → correction, good → style, none → not assessable).

### Consistency score (0–100)

Per stroke type, per metric (face tilt and swing path on drive strokes only; speed on strokes with contact, no signal
gap and no clipped gyro), needing ≥ 5 values:

- s = 1.4826 · MAD (robust standard deviation);
- floor f = noise floor: face 3° and path 3.5° (`S_MIN`, elements/catalog.ts), speed 1.5 m/s (engineering choice, about
  10 % of a typical speed estimate);
- score = 100 · exp(−max(0, s/f − 1) / 4): 100 within the floor, ≈ 78 at 2 f, ≈ 37 at 5 f, ≈ 5 at 13 f.

A stroke type's score is the mean of its available metric scores; "based on N strokes" is the number of strokes that gave
at least one value. The session score weights the type scores by N. Inside a session, "improvement" compares the score of
the first and second half (arrow at a change of ≥ 5 points).

### Other report numbers

- Speed: mean estimated head speed (contact detected, no gap) per stroke type; a "≥" lower-bound marker when any stroke's
  gyro clipped.
- Strengths: corrections judged on ≥ 10 strokes and inside the band on ≥ 70 % of them, best three.
- Errors: corrections at fault on ≥ 2 strokes, top three by count; share = faults / strokes judged on it.
- Improvement: only with ≥ 20 strokes; fault rate of the top errors in the first vs second half (judged on ≥ 3 strokes
  each); an arrow at a change of ≥ 5 percentage points.
- Main focus: the first weakness item of the training plan (`coach/plan.ts`) with its drill.

### History

`sessionHistory(sessions, strokes)` takes the newest ≤ 20 sessions with strokes and gives per session: strokes per
type, mean speed per type, consistency, and the fault rate (judged on ≥ 5 strokes) of the three corrections with the most
faults over those sessions. The Profile tab loads them on opening (`CoachController.loadHistory`).
