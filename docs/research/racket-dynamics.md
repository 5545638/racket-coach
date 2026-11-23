# Racket dynamics, single racket-IMU capabilities, and evidence for the app's heuristics

Scope: one LSM6DS3 IMU on the butt cap (gyro ±2000 deg/s, accel ±16 g, 104 Hz). The app uses gyro-only attitude anchored to gravity before the swing and rigid-lever head speed v = ω × (L·x̂).

Conventions in this file:
- **[measured]** means data reported in a study. **[opinion/qualitative]** means a statement without data or coaching opinion. **[derived]** means our own arithmetic on quoted numbers. It is shown so it can be checked, and it is not a literature finding.
- Negative times are before impact.
- "Not found" means I searched and found nothing I could read and cite. It does not mean the thing does not exist.
- Several PubMed/PMC pages were blocked by a bot check, so some numbers come from abstracts only. Each such case is flagged.

---

## 1. Time profiles of racket/segment velocity and acceleration in groundstrokes

### 1.1 Forehand, proximal-to-distal timing. Landlinger et al. 2010 [measured]
- Citation: Landlinger J, Lindinger S, Stöggl T, Wagner H, Müller E. *Key factors and timing patterns in the tennis forehand of different skill levels.* J Sports Sci Med 2010; 9:643–651. https://pmc.ncbi.nlm.nih.gov/articles/PMC3761808
- Participants: 6 elite (ATP, best ranking mean 347) and 7 high-performance (HP) youth (national top-15). Each hit 12 forehands from a ball machine at 20 m/s.
- Measurement: Vicon, 8 cameras, 400 Hz. 39 body markers and 4 racket markers. Impact was taken from a 100 Hz camera.
- Forward swing duration: elite 0.324 ± 0.086 s, HP 0.326 ± 0.064 s. The groups did not differ.
- Peak racket-head velocity: horizontal elite 33.1 ± 2.4 m/s, HP 31.1 ± 1.9 m/s. Vertical elite 18.7 ± 2.6 m/s, HP 19.2 ± 1.3 m/s.
- Peak angular velocities (elite / HP):
  - trunk 745 ± 82 / 728 ± 72 deg/s
  - pelvis 541 ± 41 / 505 ± 63 deg/s
  - shoulder internal rotation 794 ± 83 / 791 ± 218 deg/s
  - elbow extension 278 ± 96 / 313 ± 49 deg/s
- Timing of events relative to impact, elite / HP, in seconds:
  - max racket rotation angle −0.146 ± 0.042 / −0.133 ± 0.042
  - max pelvis angular velocity −0.075 ± 0.008 / −0.093 ± 0.012
  - max trunk angular velocity −0.057 ± 0.004 / −0.075 ± 0.011
  - **max wrist extension angle −0.055 ± 0.011 / −0.056 ± 0.012**
  - max elbow linear velocity −0.039 / −0.040
  - max wrist linear velocity −0.037 ± 0.005 / −0.040 ± 0.004
  - **max racket-head horizontal velocity −0.002 ± 0.000 / −0.003 ± 0.001**
  - max shoulder internal rotation velocity +0.024 (both groups)
  - max racket-head vertical velocity +0.039 ± 0.006 / +0.033 ± 0.008
- Pelvis and trunk peaks came significantly earlier in HP players. The study reports no racket angular acceleration time series.

### 1.2 Forehand. Elliott (multi-segment topspin forehand) [measured, older film data, 4 elite players]
- Citation: Elliott B. *The teaching of racquet skills: a biomechanical approach* (ISBS proceedings, citing Elliott et al. 1989). https://ojs.ub.uni-konstanz.de/cpa/article/view/3484/3277
- Maximum racket velocity occurred 0.01 s before impact.
- The racket kept about 80% of its velocity after impact.
- Ball–string contact lasted 4–6 ms.
- The wrist flexed over the last 0.08 s before impact, and the elbow flexed over the last 0.04 s.
- The upward swing path was about 0.30 rad (17°). It rose to 0.83 rad (48°) between 5 ms before and 5 ms after impact.
- The thesis by Protheroe 2011 (UCLan, https://core.ac.uk/download/340656.pdf) quotes Elliott et al. 1989a: racket-head speed at impact was 34.5 m/s for the multi-segment forehand and 32.3 m/s for the single-unit forehand.

### 1.3 Forehand speed scaling. Seeley et al. 2011 [measured; abstract only]
- Citation: *Tennis forehand kinematics change as post-impact ball speed is altered.* Sports Biomech 2011; 10(4):415–426. https://sponet.de/sponet/Record/4023740?lng=en
- Participants: 12 highly skilled players hitting slow, medium and fast forehands (ball speeds 21.4 ± 2.0, 32.1 ± 2.9 and 42.7 ± 3.8 m/s).
- From slow to fast, peak wrist extension increased by 16% and peak **wrist flexion angular velocity increased by 118%**. Trunk rotation velocity increased by 99% and elbow flexion velocity by 176%.

### 1.4 Forehand with full-body IMUs. Pedro et al. 2022 [measured]
- Citation: Pedro B, João F, Lara JPR, Cabral S, Carvalho J, Veloso AP. Sensors 2022; 22:1283. https://mdpi.com/1424-8220/22/3/1283
- Participants: 6 elite male players. Ball machine at 24.5 m/s.
- Measurement: 17 Xsens IMUs at 120 Hz.
- Racket-centre speed at impact: 21.8 ± 2.2 m/s cross-court, 22.6 ± 1.8 m/s inside-out.
- Contribution of each rotation to racket-centre speed (cross-court / inside-out):
  - upper-arm flexion/abduction 48.1% / 45.2%
  - forearm flexion/extension 17.3% / 20.9%
  - upper-arm internal rotation 15.6% / 14.2%
  - shoulder/trunk/legs 10.4% / 10.6%
  - **hand flexion/extension 4.5% / 5.3%**
  - **hand adduction/abduction 6.1% / 4.9%**
  - pronation −2.0% / −0.9%

### 1.5 Forehand racket acceleration and phase durations. Rigozzi et al. 2023 [measured]
- Citation: Rigozzi CJ, Vio GA, Poronnik P. Sensors 2023; 23:5146. https://mdpi-res.com/d_attachment/sensors/sensors-23-05146/article_deploy/sensors-23-05146.pdf
- Participants: 18 experienced and 22 recreational players. Ball machine at 80 km/h.
- Sensor: ICM20649 (±30 g, ±4000 deg/s) on the racket throat, sampled at 9 kHz.
- Peak racket (throat) resultant acceleration (this includes impact):
  - experienced 61.4 ± 7.3 g flat, 49.8 ± 7.5 g topspin
  - recreational 61.6 ± 6.4 g flat, 49.6 ± 5.3 g topspin
- Experienced players completed the acceleration phase about twice as fast as recreational players. The paper gives no seconds.
- All strokes fell within ±0.5 s of impact.
- Swing-path angle (atan of the x/z accelerations) ran from −90° to 4.3° (experienced flat), to 20.0° (experienced topspin), to 5.2° (recreational flat) and to 6.8° (recreational topspin).

### 1.6 Phase durations. Loushin et al. 2022 [measured]
- Citation: Loushin SR, Kakar S, Tetzloff SU, Lubbers P, Ellenbecker TS, Kaufman KR. Appl Sci 2022; 12:4638. https://mdpi.com/2076-3417/12/9/4638
- Participants: 20 USTA-ranked adolescents.
- Measurement: motion capture at 400 Hz. Ball machine at 18 m/s.
- Forehand phases: total 1.8 ± 0.2 s; racket preparation 1.1 ± 0.2 s; acceleration 0.3 ± 0.1 s; follow-through 0.4 ± 0.1 s.
- Backhand phases: 1.6 ± 0.4, 1.0 ± 0.3, 0.2 ± 0.1 and 0.4 ± 0.1 s, in the same order.

### 1.7 Backhands [measured, mostly via review]
- Genevois C, Reid M, Rogowski I, Crespo M. *Performance factors related to the different tennis backhand groundstrokes: a review.* J Sports Sci Med 2015; 14:194–202. https://www.jssm.org/jssm-14-194.xml-Fulltext
  - Forward-swing pelvis angular velocity: two-handed 538.5 ± 194.8 deg/s vs one-handed 280.7 ± 108.8 deg/s (Akutagawa & Kojima 2005).
  - Peak pre-impact horizontal racket-tip acceleration came significantly earlier in the one-handed backhand (Reid & Elliott 2002). No values were given.
  - Horizontal racket velocities were comparable between the two techniques. No values were given.
  - In the slice one-handed backhand, elbow extension contributed about 25% of racket velocity (Elliott & Christmas 1995).
- Busuttil N, Reid M, et al. ISBS 2020. https://core.ac.uk/download/327694109.pdf
  - Participants: 16 sub-elite adolescents hitting two-handed backhands.
  - Horizontal racket-head velocity at impact: 13.1–16.4 m/s. Vertical: 6.9–9.4 m/s.
  - Non-dominant wrist extension at impact: 43.0 ± 16.7° with a continental grip vs 34.7 ± 16.0° with an eastern grip.
- Ruiz-Malagón et al. 2025, IJRSS 4(1):16–24 (gyroscopes on trunk, head, arm and forearm; 20 players) reports only directional differences in the abstract. https://revistaseug.ugr.es/index.php/IJRSS/article/view/33359

### 1.8 Serve, for saturation context. van Trigt et al. 2025 [measured]
- Citation: Front Sports Act Living 6:1463299. https://frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2024.1463299/pdf
- Participants: 8 professionals.
- Sensor: IMUs at 1000 Hz. The upper-arm gyro had a ±20,000 deg/s range.
- Peak upper-arm angular velocity: 3207 ± 808 deg/s on first serves.
- These players did not strictly follow a proximal-to-distal sequence.

### 1.9 Racket angular velocity or angular acceleration measured on the racket in groundstrokes
- **Not found** as a reported mean ± SD time profile. Only indirect data exist:
  - **TennisEye** (Jung et al.): with a handle IMU, the smallest |gy| peak across all strokes was 814.5 deg/s. A serve trace spans about −1500 to +1000 deg/s.
  - **Ebner & Findling 2019**: racket-throat IMU. Plot axes span about ±40 rad/s and ±300 m/s². These are axis limits, not reported statistics.
  - **Huang et al. 2026**: grip IMU at 60 Hz. They used an "angular acceleration peak > 5000 deg/s²" to find impact (see §7). https://www.mdpi.com/2076-3417/16/12/5859
- **No study was found that reports when peak racket angular acceleration occurs relative to impact.**

---

## 2. Wrist: angles, lag, and whether a racket-only sensor can see it

### 2.1 Wrist angles [measured]

| Source | Participants | Measure | Value |
|---|---|---|---|
| Loushin 2022 (above) | 20 USTA adolescents | Forehand wrist flexion/extension at peak backswing | −35 ± 19° (negative = extension) |
| | | Forehand wrist flexion/extension at impact | −41 ± 20° |
| | | Forehand radial/ulnar deviation at peak backswing | −16 ± 11° (negative = ulnar) |
| | | Forehand radial/ulnar deviation at impact | −23 ± 16°. Maximum ulnar deviation occurs at impact. |
| Pedro 2022 | 6 elite, Xsens | Wrist flexion/extension at impact | −30.4 ± 13.3° cross-court, −31.3 ± 12.7° inside-out |
| Landlinger 2010 | 6 elite, 7 HP | Maximum wrist extension | 88.7 ± 10.2° elite, 84.5 ± 7.8° HP, reached at −55 ± 11 / −56 ± 12 ms |

- Landlinger used a different angle convention from Loushin, so the absolute values are not comparable.
- Loushin found that players ranked better than 500 reached greater wrist extension velocity before impact (SPM, p = 0.01). Numbers are shown only in figures.

### 2.2 "Lag" and speed
- The literature reports maximum wrist extension (the "lag" position) at about **−55 ms**, followed by wrist flexion (Landlinger [measured]).
- Elliott describes wrist flexion over the last **80 ms** before impact. This is from older film data.
- Seeley 2011: wrist flexion velocity is 118% higher in fast forehands than slow ones.
- Elliott, Takahashi & Noffal 1997 (J Appl Biomech 13:182–196; 6 eastern-grip and 6 western-grip high-performance players): the hand segment's contribution to racket speed differed significantly by grip. The abstract gives no numbers. https://www.bisp-surf.de/Record/PU199804301579
- Pedro 2022: wrist (hand) rotations together contribute about 10–11% of racket-centre speed.
- **Evidence that a "relaxed wrist/grip" increases racket speed: not found.** This is coaching opinion only.

### 2.3 Can a racket-only sensor infer wrist angles?
- **No study was found that estimates wrist angle or wrist velocity from a racket-only sensor.**
- Every wrist study I found used segment sensors or markers on the hand and forearm:
  - Maeda & Okauchi 2013: IMUs on the back of the hand and the forearm. https://www.jstage.jst.go.jp/article/jsmeshd/2013/0/2013__210-1_/_article/-char/en
  - Pedro 2022: full-body Xsens suit.
  - Loushin, Landlinger and Busuttil: marker-based motion capture.
- Racket angular velocity is the sum of segment angular velocities through the chain (Pedro's method), so wrist rotation cannot be separated from forearm and shoulder rotation with one sensor.
- **Conclusion: a forearm (or hand) sensor is required to measure the wrist.**

### 2.4 Off-centre impact forces the wrist [measured]
- Citation: King MA, Hau A, Blenkinsop GM. J Sports Sci. https://core.ac.uk/download/288371568.pdf
- Participants: 14 university players hitting one-handed backhands. Motion capture at 480 Hz.
- An impact 68 mm below the long axis forced 11–32° of wrist flexion and 43–94° of racket rotation about its long axis within 30 ms after impact.
- The effect was significant in 14 of 14 players.

---

## 3. Grip force and ball rebound; what the racket can sense after impact

### 3.1 Grip and rebound [measured]
- **Cross & Lindsey 2019** (Tennis Warehouse University, experimental). Balls at 15 m/s, free-standing vs hand-held racket: **"essentially no difference in ACOR"**. https://twu.tennis-warehouse.com/learning_center/freehandheld.php
  - ACOR was about 0.5 at the throat, 0.4 at the centre and 0.1–0.2 at the tip.
  - The number of impacts was not stated.
- **Knudson 1997** (ISBS). Off-centre impacts (20 ± 5 mm), 12 per condition. https://ojs.ub.uni-konstanz.de/cpa/article/view/3656
  - Rebound angle: clamped 14.6°, hand-held 16.3°, free-standing 17.0°.
  - The clamped condition was more accurate than the other two. Hand-held and free-standing did not differ.
  - Grip model explained 41% of the variance (η² = 0.409).
- **Plagenhoef** (ISBS, undated, references up to 1980). https://ojs.ub.uni-konstanz.de/cpa/article/view/909/827
  - Coefficient of restitution at centre hits: 0.40 and 0.35 with a clamped handle vs 0.40 and 0.37 with a rubber-encased handle.
  - Two inches off centre: clamped 0.38 and 0.33 vs rubber 0.33 and 0.29.
  - Hand force was 28–56 lb in groundstrokes. Hand squeeze started about 0.2 s before impact.
- **Hatze 1976** (Med Sci Sports 8:88–95; abstract only). A tight grip increases the impulse given to the ball. One top player gripped tightly on all strokes. "Avoidance of the impact recoil was found to be impossible." The abstract has no numbers. https://www.bisp-surf.de/Record/PU197800024154
- **Rigozzi 2023**, handle pressure sensor:
  - Grip at impact was about 89–90% of maximal voluntary contraction in both experienced and recreational players, with no difference between groups.
  - Experienced players peaked during the acceleration phase (about 96.5% MVC).
  - Recreational players peaked just after impact (about 93–94% MVC).
- **Summary:** for central impacts, grip firmness has little or no measured effect on rebound speed. For off-centre impacts it affects rebound direction and coefficient of restitution somewhat. No study shows that a looser grip increases ball speed.

### 3.2 Vibration and impact signatures [measured]
- Russell (Penn State), freely supported racket: first bending mode 146 Hz, first torsional 382 Hz, second bending 411 Hz. The first bending mode has a handle node about 5 inches from the butt. https://www.acs.psu.edu/drussell/Demos/tennis/tennis-1.html
- **At 104 Hz sampling (Nyquist 52 Hz) the app cannot resolve these modes. They will alias.** [derived]
- Naß, Hennig & Schnabel 1998: 19 experts. Arm shock and vibration (wrist accelerometer) were lowest for impacts closer to the handle than the classical sweet spots. https://ojs.ub.uni-konstanz.de/cpa/article/view/981
- Rigozzi 2023: racket-to-wrist shock transfer was 12.6–22.0%, racket-to-elbow 2.1–3.4%.
- Lyu & Smith (Proc IMechE P, 2022/2025): baseball-bat impact location can be estimated from knob accelerations (mode-1 and mode-2 magnitudes normalised by swing speed). "Good agreement" was reported, with no numbers in the abstract. https://journals.sagepub.com/doi/10.1177/17543371221112239

---

## 4. Racket-mounted IMUs and commercial sensors

| System / study | Mount | Sensor, range, rate | Impact or stroke detection | Validated accuracy |
|---|---|---|---|---|
| **TennisEye** (Jung et al., IPSN 2019). https://www.cs.wm.edu/~wsjung/publications/papers/TennisEye_IPSN2019.pdf | Handle | ±16 g, ±2000 deg/s, 100 Hz | Stroke when X-axis acceleration > **9 g** (F 97.8%). Impact = \|gy\| peak in a ±1 s window. | Ball speed error 5.6 ± 4.9 mph (88.2% accuracy) vs Zepp 8.9 ± 7.8 mph (77.4%). 7 players, 1985 shots. Gyro **saturated in fast serves**; repaired with a cubic spline. Racket speed = \|gy\| × 0.72 m (0.2 m from butt to rotation centre + 0.52 m to face centre). |
| **SmartDampener** (Liu et al., IMWUT 2024). https://www.cse.psu.edu/~mkg31/papers/smartdamp.pdf | Strings (dampener) | ICM-20948 (range not stated), BLE at about 100 Hz, spline-resampled to 500 Hz | Stroke when the gyro changes by > **400 deg/s between consecutive samples** on any axis (96.69% segmentation). | 6-class stroke accuracy 96.75%. Ball speed median error 3.59 mph (7.76%) vs SwingVision. Impact location median about 3.0–3.3 cm. Front/back face 99.7%. 15 players. Gyro **saturates during intense impacts**. Spin not estimated. |
| **Ebner & Findling 2019** (MoMM). https://ambientintelligence.aalto.fi/paper/Tennis_Stroke_Recognition.pdf | Racket throat vs wrist | ±160 m/s², ±1200 deg/s, 100 Hz | Peak in the derivative of mean acceleration, threshold ±15 m/s³ (as printed) | Racket 98.23% user-dependent, about 90% leave-one-subject-out. Serves and smashes **exceeded the 16 g range** on x. 5 players. |
| **Rigozzi 2023 TRAM-2** | Throat | ±30 g, ±4000 deg/s, 9 kHz | Impact when z (normal to strings) > **20 g**. Prep/follow-through bounded by \|a\| crossing 1 g. | Not validated against a gold standard |
| **Huang et al. 2026** | Top of grip (Xsens DOT) | 60 Hz | Impact when angular acceleration peaks > **5000 deg/s²**. Start = local maximum of yaw angle. Set = local minimum of angular velocity. | Event rules not validated (stated limitation) |
| **TennisMaster** (Yang et al., AH 2017). https://www.microsoft.com/en-us/research/uploads/prod/2017/01/a17-yang.pdf | Racket bottom and shank | BMI160, 100 Hz | About 5 g for candidate serves. Impact = acceleration max–min–max "hop". | Serve detection precision 96%. 12 players. |
| **Babolat Play & Zepp** (Keaney & Reid, Sports Biomech, online 2018, doi 10.1080/14763141.2018.1535619). https://informahealthcare.com/doi/epub/10.1080/14763141.2018.1535619 | Handle | — | — | Vs VICON 500 Hz, 1 national player, 24 shots. Stroke count matched. Zepp racket speed ICC 0.983. Stroke type κ 0.730 (Babolat), 0.612 (Zepp). **Impact location κw 0.412 (Babolat), 0.217 (Zepp).** |
| **Zepp1/Zepp2/Qlipp** (Delgado-García et al., IJRSS 2025). https://revistaseug.ugr.es/index.php/IJRSS/article/download/33264/28961/143775 | Zepp2 on grip | Not reported | — | Zepp1 vs racket 3D: MAE 7 km/h, CCC 0.91. Zepp2 ball-speed MAE about 8 km/h (forehand), about 11 km/h (backhand). Error grows with speed. 13 players, mixed level. |
| **Babolat POP** (Raymond et al., J Sport Hum Perf 2019). https://jhp-ojs-tamucc.tdl.org/JHP/article/download/146/pdf/648 | Wrist | — | — | Drill MAPE 32%. More than 60% of volleys and more than 90% of overheads missed or misclassified. Topspin often called flat. 17 collegiate players. |
| **Bat sensors** (Morishita & Jinji, Sports 2022). https://www2.mdpi.com/2075-4663/10/2/21 | Knob | — | — | Swing speed ICC 0.67–0.91 (mean 0.78), all biased low. Swing-angle ICC mean 0.58. Error grows above about 30 m/s; **accelerometer saturation near impact suspected**. 7 participants. |
| **Zepp Golf 2** (Lückemann et al., Proceedings 2018). https://mdpi.com/2504-3900/2/6/246 | Glove | — | — | Club speed bias −2.7 to +4.6 km/h. Limits of agreement ±13.8–16.0 km/h (±11–13%). Good for averages, not single swings. Cites a bat study reporting 8% underestimation from 16 g saturation. |

### 4.1 Handle vs string mount
- SmartDampener's authors argue that handle and wrist mounts are far from the impact area, which limits sensing. String-mounted impact location reached about 3 cm median error.
- Handle-mounted commercial sensors showed poor impact-location agreement (κw 0.22–0.41, Keaney & Reid).
- I found no direct handle-vs-strings comparison on the same impacts.

### 4.2 Saturation at ±2000 deg/s / ±16 g
- Documented:
  - TennisEye: ±2000 deg/s gyro on the handle saturated in fast serves.
  - Ebner: ±16 g exceeded at the racket throat in serves and smashes.
  - Golf wrist IMU at ±16 g / ±2000 deg/s: clipping in 150 of 389 swings, at impact.
- [derived] With peak forehand racket-head speeds of 31–33 m/s (Landlinger) and TennisEye's 0.72 m radius, ω ≈ 43–46 rad/s ≈ 2500–2600 deg/s. That is above ±2000 deg/s. So **fast forehands may saturate the gyro around impact**, not only serves. This is a calculation, not a measurement.
- Recommendation: detect clipped samples (|value| ≥ 0.99 × full scale) and flag or spline them, as TennisEye, SmartDampener and the golf study did.

---

## 5. Racket-head speed from ω × radius

- **TennisEye** uses v = |gy| × 0.72 m: 0.2 m from butt to rotation centre (taken from Brody) plus 0.52 m from butt to face centre. **Racket speed itself was not validated.** Only downstream ball speed was (errors above).
- **Mitchell, Jones, King & Kotze 2001** (Med Sci Tennis 6(1); 6 university players, serve). The instantaneous centre of rotation averaged **12.6 ± 3.0 cm behind and 18.0 ± 3.1 cm below the racket butt**. It was "surprisingly consistent" across rackets. https://www.lboro.ac.uk/microsites/ssehs/biomechanics/papers/racket-inertia-tennis-serve-3d-analysis.pdf
- **Pedro 2022** computes racket speed as the sum over all segments of ω × r. That is the multi-segment chain, not a single rigid lever.
- **Forehand-specific effective radius: not found.**
- **Validation of single-sensor ω × L against motion capture for tennis: not found.** Closest evidence:
  - Zepp (algorithm unknown) racket speed ICC 0.983 vs VICON (1 player).
  - Bat sensors biased low, with about 8% precision error.
- Note [derived]: the formula assumes pure rotation about the butt. The measured rotation centre lies beyond the butt (about 0.2 m), so v = ω·L, with L measured from the butt, will **underestimate** head speed by roughly L_icr/L_total. With 0.2/0.72 that is about 28% if the centre-of-rotation offset is ignored. The app should either add the offset (as TennisEye does) or calibrate per user.

## 6. Attitude drift over about 1 s of gyro integration

- LSM6DS3 datasheet (ST). https://docs.arduino.cc/resources/datasheets/LSM6DS3-datasheet.pdf
  - Zero-rate level ±10 dps typical
  - Zero-rate change with temperature ±0.05 dps/°C
  - Rate noise density 7 mdps/√Hz
  - Sensitivity change with temperature ±1.5%
  - Sensitivity tolerance not listed in the table
- [derived] An unremoved bias of 10 dps gives about 10° error per second. If the bias is estimated during the quiet pre-swing window, the residual is dominated by scale-factor error: 1.5% of a total swing rotation of about 180–300° is about 3–5°. Clipping makes it much worse, because the integrated angle is lost while the gyro is clipped.
- **Williams et al. 2019** (Sports Biomech 18(2):202–214). Magnetic-inertial unit on a squash racket, 10 players × 10 forehands vs optical motion capture: mean orientation error at impact < 0.50°, swing RMSE ≤ 2.20°. https://digital.library.adelaide.edu.au/items/b5a81d0e-1ec6-4e75-8fa0-e256f9690a3d/full
- **Golf, single wrist IMU** (Sci Rep 2024, s41598-024-59949-w; ±16 g, ±2000 dps, 200 Hz). https://www.nature.com/articles/s41598-024-59949-w
  - Initial orientation is estimated by a CNN.
  - Drift is controlled by forcing velocity to zero at address, top and finish.
  - Orientation error 9.5 ± 3.2° over a 2.14 s swing.
- **McGinnis & Perkins 2012** (Sports Eng 15:41–52, knob IMU): the abstract does not give its orientation and anchoring details.
- The orientation methods used by Blast Motion and Zepp are **not found** (proprietary).
- The app's method (gravity anchor at rest, then integrate the gyro) is consistent with common practice. **Heading (yaw) cannot be anchored without a magnetometer.**

## 7. Preparation timing

- **Carboch, Süss & Kocib 2014** (J Sports Sci Med 13:304–308; 14 Czech top-200 players returning serves). https://www.jssm.org/jssm-13-304.xml-Fulltext
  - Movement initiation, measured from ball release or server contact: median 0.38 s (ball machine) and 0.41 s (real server).
  - **Backswing duration: median 0.59 s (machine) and 0.49 s (real server).**
  - Forward swing 0.16–0.17 s.
  - Time available for the swing 0.66–0.68 s.
- **Mecheri et al. 2019** (J Sports Sci; 22 world-class players returning 140–190 km/h serves): first racket movement 187 ± 22 ms after the server's impact. No difference between groups. https://pure.port.ac.uk/ws/files/13666713/Mecheri_et_al._Accepted.pdf
- **Huang, Zhang, Li & Li 2026** (Appl Sci 16:5859; 15 high-skill players, NTRP ≥ 5.0, and 15 low-skill players, NTRP 3.5–4.5; grip IMU at 60 Hz plus 120 Hz video).
  - Index of preparation = (time of racket set − time of bounce) / stroke duration.
  - High-skill players: dominant mode +3.4 ± 6.3% (85.8% of trials).
  - Low-skill players: 57.8% of trials in the late mode at −10.9 ± 6.8%.
  - So **skilled players usually complete the racket set before the bounce. Less skilled players more often set after the bounce, and more so as ball speed increases.**
  - Durations in seconds were not available in the text I could read.
- Loushin 2022: forehand "racket preparation" phase 1.1 ± 0.2 s (ball machine at 18 m/s).
- Landlinger 2010: forward swing 0.32 s in both elite and HP groups.
- **Numeric "unit turn" benchmarks: not found.**
- **A single racket IMU cannot observe the bounce.** The literature's skill-discriminating measure (set relative to bounce) therefore cannot be computed without audio or video of the bounce.

## 8. Motor learning: augmented and real-time feedback

- **Moran, Murphy, Marshall et al. 2012** (Med Sci Sports Exerc 44(4):754–760; ISBS version lists Moran, Murphy, Cahill, Marshall). https://lida.sport-iat.de/twm/Record/4025020?lng=en and https://ojs.ub.uni-konstanz.de/cpa/article/view/3269/3071
  - Players could not judge their own serve speed.
  - Twelve national juniors trained for 6 weeks with radar speed shown within 1 s (knowledge of results).
  - The feedback group gained +0.84 ± 0.38 m/s vs +0.22 ± 0.04 m/s (p = 0.01; r = 0.68). The gain was retained 6 weeks later.
- **External focus.** Chua et al. 2021 (Psychol Bull 147(6):618–645). https://oasis.library.unlv.edu/kns_fac_articles/424/
  - Performance g = 0.264 (73 studies)
  - Retention g = 0.583 (95% CI 0.425–0.741)
  - Transfer g = 0.584
  - Distal vs proximal external focus g = 0.224
  - Caveat: McKay et al. 2024 argue the effect is inflated by reporting bias. I could not open the full text to give their corrected estimate.
- **Reduced feedback frequency** (meta-analysis, k = 37 studies, N = 1145; SCAPPS/JEMS abstract, authors not shown on the page). Hedges' g = 0.21 at delayed retention and 0.06 at immediate retention. The difference between timepoints was not significant (p = 0.47). https://scapps.org/jems/index.php/1/article/view/2529
- **Concurrent vs terminal and multimodal feedback.** Hegi, Heitz & Kredel 2023 (Front Sports Act Living 5:1145247) found evidence too heterogeneous to pool. https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2023.1145247/pdf
  - Cited work: Sigrist et al. 2013 found terminal feedback outperformed concurrent feedback in a rowing-type task. Concurrent feedback may help more as task complexity grows.
  - Self-selected feedback averaged 9% of trials.
- **Sonification.** Evidence comes from golf putting only. O'Brien et al. 2020 (Exp Brain Res 238:883–895) sonified club-head speed and found reduced variability in novices. https://link.springer.com/article/10.1007/s00221-020-05757-3
  - Coers et al. 2026 (Perceptual and Motor Skills) found no tennis or racket-sport sonification studies. https://scholarlypublications.universiteitleiden.nl/access/item%3A4308306/view
  - **Racket-sport sonification RCT: not found.**
- **General educational feedback:** motor-skill subgroup d = 0.63 (19 effect sizes; Wisniewski, Zierer & Hattie 2020, Front Psychol 10:3087).
- **Implications for the app** (inference from the above, not a tested protocol):
  - Give outcome-type, external-focus feedback (racket speed, swing path, contact consistency) rather than body-part cues.
  - Do not give feedback after every stroke. Use summary or self-selected feedback.
  - Terminal feedback is fine. Real-time cues are untested in tennis.

---

## (a) Heuristic in app → evidence → recommendation

| Heuristic in app | Evidence | Recommended value |
|---|---|---|
| **Wrist lag / whip**: peak racket angular acceleration at < −150 ms before contact = good | Measured peak wrist extension (the lag) is at about −55 ms (Landlinger; elite and HP). Wrist flexion happens over the last about 80 ms (Elliott). Racket-head speed peaks at −2 to −10 ms. No study reports when racket angular acceleration peaks. No study infers the wrist from a racket sensor. | **Keep as heuristic, tune on user data.** Do not label it "wrist". A −150 ms threshold has no support; the literature points to lag release in the last 50–80 ms. At 104 Hz one sample is about 9.6 ms, so these events are only 5–8 samples apart. Consider renaming it "late acceleration" and reporting it only relative to the user's own baseline. |
| **Preparation** < 600 ms = late | Backswing durations of 0.49–0.59 s (median) were measured in skilled players on fast returns (Carboch). Forehand preparation was 1.1 ± 0.2 s from a slow ball machine (Loushin). The skill-discriminating measure is racket set vs bounce (Huang 2026), which a racket IMU cannot see. | **Keep as heuristic, tune on user data.** 600 ms would flag skilled return-of-serve preparations as late. Make it ball-speed and context dependent. Prefer "set reached X ms before impact". Ideally add microphone or video detection of the bounce. |
| **Racket drop**: lowest tip elevation > −15° = no drop | No measured benchmark for the racket-tip elevation minimum was found. Related measures: swing path about 17° upward (Elliott); trajectory 18.6 ± 4.3° over the last 42 ms (Kwon et al. 2017, J Sports Sci Med 16:505, 13 NCAA D-I players, https://www.jssm.org/jssm-16-505.xml-Fulltext); throat-accelerometer path from −90° to 4–20° (Rigozzi). Busuttil (two-handed backhand) racket horizontal angle at peak backswing 111–122°. | **Keep as heuristic, tune on user data.** A path-angle metric (upward swing path in the last about 40 ms, target range about 15–20° measured for topspin forehands) is better supported than tip elevation. It also depends on yaw-free pitch, which the gravity anchor gives. |
| **Follow-through** < 120° rotation = short | No measured follow-through rotation in degrees was found. Follow-through duration was 0.4 ± 0.1 s (Loushin). Racket path steepens from 17° to 48° within ±5 ms of impact (Elliott). | **Keep as heuristic, tune on user data.** Gyro integration after impact is also corrupted by impact shock and possible clipping. |
| **Contact detection**: > 6 g jump between samples | Thresholds used elsewhere: handle X-axis > 9 g (TennisEye, F = 97.8%); gyro jump > 400 deg/s between samples (SmartDampener, 96.7%); z > 20 g at the throat at 9 kHz (Rigozzi); angular acceleration > 5000 deg/s² at 60 Hz (Huang); acceleration max–min–max "hop" (TennisMaster). Contact lasts 4–6 ms (Elliott), which is shorter than the 9.6 ms sample period. | **Use a combined detector.** Use an acceleration jump (6–9 g; tune per user) **and** a gyro sample-to-sample jump (≥ 400 deg/s) or a gyro peak near the acceleration spike. Require a minimum gap between strokes and treat clipped samples as candidate impacts. Validate against audio of contact if possible. |
| **Head speed** v = ω·L (rigid lever about the butt) | The rotation centre is about 0.2 m beyond the butt (Mitchell 2001: 12.6 cm behind and 18 cm below the butt, serve). TennisEye used R = 0.72 m. No forehand-specific validation was found. Commercial knob and handle sensors have about 8–13% precision error and grow worse at high speed. | Use L + about 0.2 m, or calibrate per user (for example against a radar or app ball speed). Report as relative or trend data, not absolute m/s. Flag gyro clipping (forehands may exceed 2000 deg/s [derived]). Consider ±16 g accelerometer saturation as expected at impact. |

## (b) What a single racket IMU fundamentally cannot determine

1. **Wrist, forearm, elbow or shoulder joint angles and velocities.** Racket ω is the sum of all segment rotations. "Wrist lag" can only be guessed. No study infers it from a racket-only sensor.
2. **Body sequencing** (pelvis → trunk → arm timing, separation angle, stance, footwork, split step).
3. **Ball events other than contact**: bounce time, incoming ball speed and spin. So preparation relative to bounce (the skill-discriminating measure) cannot be computed.
4. **Outgoing ball speed, spin and direction.** These are only model or regression estimates, with errors of about 5 mph (≈ 2.2 m/s) at best (TennisEye, SmartDampener).
5. **Absolute heading (yaw)** without a magnetometer, and absolute position or trajectory in space (double integration drifts).
6. **Precise impact location on the string bed** from the handle. Handle-mounted products agree poorly (κw 0.22–0.41). String-mounted sensors do better (about 3 cm). At 104 Hz the frame modes (146 Hz and up) are aliased.
7. **True peak values when the sensor clips** (> 2000 deg/s or > 16 g), and accurate attitude through and after a clipped interval.
8. **Grip force or "relaxation"** (needs a pressure sensor). The literature shows no grip-tightness effect on central-impact rebound speed anyway.
9. **Exact impact timing better than about ±1 sample (9.6 ms) at 104 Hz.** Contact itself lasts 4–6 ms.

### Items searched but not found or not readable
- Racket angular-acceleration time profiles with timing relative to impact.
- Forehand effective rotation radius.
- Validation of ω × L racket speed against motion capture.
- Numeric unit-turn benchmarks.
- Racket-sport sonification trials.
- Blast and Zepp orientation algorithms.
- Full texts of Bahamonde, Rogowski, Kos & Kramberger, Pei, Büthe and Whiteside (PMC or university pages were blocked or not located).
- The McKay 2024 bias-corrected external-focus estimate.
