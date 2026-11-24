import { describe, expect, it } from 'vitest';
import { CoachController } from '../../src/app/controller';
import { ANALYSIS_VERSION } from '../../src/metrics/version';
import { analyzeCapture } from '../../src/app/pipeline';
import { DEFAULT_RULES } from '../../src/coaching/defaultRules';
import { SilentSpeaker } from '../../src/feedback/speech';
import { SimulatedTransport } from '../../src/transport/simulatedTransport';
import type { StrokeRecord } from '../../src/domain/types';
import { InMemoryRepository, immediateScheduler } from '../fakes';
import { GOOD_FOREHAND_V3 } from '../fixtures';

/** A stroke from an earlier session (with features). */
const earlierStroke = (id: string, receivedAt: number): StrokeRecord => ({
  id,
  sessionId: 'earlier',
  capture: {
    kind: 'swing',
    sequence: 1,
    sampleRateHz: 104,
    accelGPerLsb: 0.000488,
    gyroDpsPerLsb: 0.07,
    triggerIndex: 0,
    samples: Int16Array.of(1, 2, 3, 4, 5, 6),
    receivedAt,
  },
  metrics: GOOD_FOREHAND_V3,
  cue: { ruleId: 'good', severity: 'good', text: 'Good' },
  analysisVersion: 2,
});

/** Timers that run only when the test fires them. */
class ManualTimers {
  readonly pending: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  readonly set = (fn: () => void, ms: number): (() => void) => {
    const timer = { fn, ms, cancelled: false };
    this.pending.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  live() {
    return this.pending.filter((t) => !t.cancelled);
  }
}

async function setup(repository = new InMemoryRepository(), timers = new ManualTimers()) {
  const speaker = new SilentSpeaker();
  let id = 0;
  const controller = new CoachController({
    repository,
    speaker,
    now: () => 1_700_000_000_000,
    newId: () => `id-${++id}`,
    sleep: () => Promise.resolve(),
    setTimer: timers.set,
    reconnectAttempts: 2,
  });
  await controller.init();
  const transport = new SimulatedTransport(4000, immediateScheduler, 7);
  await controller.connect(transport);
  return { controller, repository, speaker, transport };
}

describe('CoachController end-to-end with the simulated sensor', () => {
  it('connects, reads status and opens a session', async () => {
    const { controller } = await setup();
    expect(controller.connection.value).toBe('connected');
    expect(controller.status.value?.firmwareVersion).toBe('0.1.0');
    expect(controller.session.value?.id).toBe('id-1');
  });

  it('ignores swings until the sensor is calibrated', async () => {
    const { controller, transport } = await setup();
    transport.emitSwing();
    expect(controller.strokes.value).toHaveLength(0);
    expect(controller.log.value[0]?.text).toContain('calibrate');
  });

  it('calibrates through the wire protocol, then analyses and voices strokes', async () => {
    const { controller, repository, speaker, transport } = await setup();
    await controller.capturePose('faceUp');
    expect(controller.calibrationStep.value.step).toBe('awaitTipUp');
    await controller.capturePose('tipUp');
    expect(controller.calibrationStep.value.step).toBe('done');
    expect(repository.calibrations.get('RacketCoach (demo)')).toBeDefined();

    for (let i = 0; i < 6; i++) transport.emitSwing();
    await Promise.resolve();

    expect(controller.strokes.value).toHaveLength(6);
    expect(repository.strokes).toHaveLength(6);
    for (const s of controller.strokes.value) {
      expect(s.metrics.impactDetected).toBe(true);
      expect(s.metrics.quality.attitudeReliable).toBe(true);
    }
    // The coaching engine decides what is said (speakGood is off by default).
    const said = controller.strokes.value.filter((s) =>
      ['correction', 'better', 'keep-it'].includes(s.coach?.utterance ?? 'silent'),
    );
    expect(speaker.spoken).toHaveLength(said.length);
    for (const s of controller.strokes.value) expect(s.coach).toBeDefined();
    expect(controller.assessment.value?.contact).toBe(true);
    expect(controller.utterance.value).not.toBeNull();
  });

  it('builds the personal baseline from earlier sessions and grows it with every stroke', async () => {
    const repository = new InMemoryRepository();
    for (let i = 0; i < 20; i++) {
      await repository.saveStroke(earlierStroke(`old-${String(i)}`, i));
    }
    const { controller, transport } = await setup(repository);
    expect(controller.baselineLoading.value).toBe(false);
    expect(controller.baselineCounts.value.forehand).toBe(20);
    const faceKey = 'forehand|drive|full|faceTiltDeg';
    expect(controller.baseline.value.entries[faceKey]?.active).toBe(true);
    expect(controller.baseline.value.entries[faceKey]?.median).toBe(GOOD_FOREHAND_V3.faceTiltDeg);

    await controller.capturePose('faceUp');
    await controller.capturePose('tipUp');
    for (let i = 0; i < 3; i++) transport.emitSwing();
    const counts = controller.baselineCounts.value;
    expect(counts.forehand + counts.backhand + counts.overhead).toBe(23);
    // The assessment used the baseline: personal bands are in play.
    const sources = controller.assessment.value?.elements.map((e) => e.bandSource) ?? [];
    expect(sources.some((src) => src === 'combined' || src === 'personal')).toBe(
      controller.lastStroke.value?.metrics.strokeType === 'forehand' &&
        controller.lastStroke.value.metrics.swingStyle === 'drive',
    );
  });

  it('resets the personal baseline and ignores older strokes from then on', async () => {
    const repository = new InMemoryRepository();
    for (let i = 0; i < 20; i++) {
      await repository.saveStroke(earlierStroke(`old-${String(i)}`, i));
    }
    const { controller } = await setup(repository);
    expect(controller.baselineCounts.value.forehand).toBe(20);

    await controller.resetBaseline();
    expect(controller.baselineCounts.value.forehand).toBe(0);
    expect(controller.baseline.value.entries).toEqual({});
    expect(controller.settings.value.baselineResetAt).toBe(1_700_000_000_000);
    expect(repository.settings?.baselineResetAt).toBe(1_700_000_000_000);

    // The next session does not bring the old strokes back.
    await controller.startSession();
    expect(controller.baselineCounts.value.forehand).toBe(0);
  });

  it('stores version, parameters and calibration so a stroke can be re-analysed exactly', async () => {
    const { controller, repository, transport } = await setup();
    await controller.capturePose('faceUp');
    await controller.capturePose('tipUp');
    await controller.updateSettings({ leverRadiusM: 1.3 });
    transport.emitSwing();
    const first = repository.strokes[0];
    expect(first?.analysisVersion).toBe(ANALYSIS_VERSION);
    expect(first?.analysisParams?.leverRadiusM).toBe(1.3);
    const used = repository.calibrations.get('RacketCoach (demo)');
    expect(first?.calibration).toEqual(used);

    // Later changes to settings and calibration do not alter the stored stroke.
    await controller.updateSettings({ leverRadiusM: 0.8 });
    await controller.capturePose('faceUp');
    await controller.capturePose('tipUp');
    expect(first?.analysisParams?.leverRadiusM).toBe(1.3);

    if (!first?.analysisParams || !first.calibration) throw new Error('provenance missing');
    const again = analyzeCapture(
      first.capture,
      first.calibration,
      first.analysisParams,
      DEFAULT_RULES,
    );
    expect(again.metrics).toEqual(first.metrics);
  });

  it('stays silent per stroke in match mode', async () => {
    const { controller, speaker, transport } = await setup();
    await controller.capturePose('faceUp');
    await controller.capturePose('tipUp');
    await controller.updateSettings({ mode: 'match', speakGood: true });
    for (let i = 0; i < 4; i++) transport.emitSwing();
    expect(controller.strokes.value).toHaveLength(4);
    expect(speaker.spoken).toHaveLength(0);
    // Coaching still runs, so the session can be reviewed afterwards.
    expect(controller.utterance.value).not.toBeNull();
    expect(controller.strokes.value.every((s) => s.coach !== undefined)).toBe(true);
  });

  it('stores the adaptive coaching outcome and keeps the profile up to date', async () => {
    const repository = new InMemoryRepository();
    for (let i = 0; i < 20; i++) {
      await repository.saveStroke(earlierStroke(`old-${String(i)}`, i));
    }
    const { controller, transport } = await setup(repository);
    expect(controller.profile.value.typical.forehand.n).toBe(20);
    await controller.capturePose('faceUp');
    await controller.capturePose('tipUp');
    for (let i = 0; i < 3; i++) transport.emitSwing();
    for (const s of controller.strokes.value) {
      expect(s.coach?.mode).toBe('training');
      expect(s.coach?.fatigueActive).toBe(false);
      expect(s.coach?.categories?.counts).toBeDefined();
      expect(s.coach?.phraseLevel === null || typeof s.coach?.phraseLevel === 'number').toBe(true);
    }
    const typed = controller.strokes.value.filter((s) => s.metrics.impactDetected).length;
    const total = Object.values(controller.profile.value.typical).reduce((n, t) => n + t.n, 0);
    expect(total).toBe(20 + typed);
    expect(controller.categories.value).not.toBeNull();
    expect(controller.fatigueActive.value).toBe(false);
    expect(controller.plan.value.items.length).toBeLessThanOrEqual(3);
    expect(controller.weaknesses.value).toEqual(controller.profile.value.weaknesses);
    expect(controller.progress.value.map((p) => p.sessionId)).toContain('id-1');
  });

  it('match mode: checks for a persistent major fault once play pauses, at most once per 10 min', async () => {
    const timers = new ManualTimers();
    const { controller, speaker, transport } = await setup(new InMemoryRepository(), timers);
    await controller.capturePose('faceUp');
    await controller.capturePose('tipUp');
    await controller.updateSettings({ mode: 'match' });
    transport.emitSwing();
    transport.emitSwing();
    // One live timer: the previous stroke's check is cancelled by the next stroke.
    expect(timers.live()).toHaveLength(1);
    expect(timers.live()[0]?.ms).toBe(8_000);
    expect(speaker.spoken).toHaveLength(0);

    // A pending major fault and a pause long enough: the cue is said once.
    const state = controller.coachState.value;
    controller.coachState.value = {
      ...state,
      lastStrokeAt: 1_700_000_000_000 - 9_000,
      match: { pending: { correctionId: 'face-open', strokeType: 'forehand' }, lastSpokenAt: null },
    };
    timers.live()[0]?.fn();
    expect(speaker.spoken).toEqual(['Face too open']);
    expect(controller.utterance.value?.reason).toBe('persistent-major-fault');
    controller.coachState.value = {
      ...controller.coachState.value,
      match: {
        pending: { correctionId: 'face-open', strokeType: 'forehand' },
        lastSpokenAt: 1_700_000_000_000,
      },
    };
    controller.checkMatchBreak();
    expect(speaker.spoken).toEqual(['Face too open']);
  });

  it('rebuilds the baseline when the playing hand changes', async () => {
    const repository = new InMemoryRepository();
    for (let i = 0; i < 20; i++) {
      await repository.saveStroke(earlierStroke(`old-${String(i)}`, i));
    }
    const { controller } = await setup(repository);
    const before = controller.baseline.value;
    await controller.updateSettings({ dominantHand: 'left' });
    expect(controller.policy.value.inputs.dominantHand).toBe('left');
    expect(controller.baseline.value).not.toBe(before);
    expect(controller.baselineCounts.value.forehand).toBe(20);
    await controller.updateSettings({ level: 'beginner' });
    expect(controller.policy.value.assess.pMin).toBe(0.85);
  });

  it('refuses the second calibration pose before the first', async () => {
    const { controller } = await setup();
    await controller.capturePose('tipUp');
    expect(controller.calibrationStep.value).toEqual({
      step: 'failed',
      reason: 'Do the face-up step first.',
    });
  });

  it('reports and recovers from a dropped link', async () => {
    const { controller, speaker, transport } = await setup();
    transport.simulateLinkLoss();
    expect(controller.connection.value).toBe('disconnected');
    await new Promise((r) => setTimeout(r, 0));
    expect(speaker.spoken).toEqual(['Sensor disconnected', 'Sensor connected']);
    expect(controller.connection.value).toBe('connected');
  });

  it('turns a storage failure during calibration into a visible error', async () => {
    class FailingRepository extends InMemoryRepository {
      override saveCalibration() {
        return Promise.reject(new Error('QuotaExceededError'));
      }
    }
    const { controller } = await setup(new FailingRepository());
    await controller.capturePose('faceUp');
    await controller.capturePose('tipUp');
    expect(controller.calibrationStep.value).toEqual({
      step: 'failed',
      reason: 'QuotaExceededError',
    });
  });

  it('ignores a connection attempt that finishes after the user disconnected', async () => {
    const repository = new InMemoryRepository();
    const controller = new CoachController({ repository, speaker: new SilentSpeaker() });
    const transport = new SimulatedTransport(4000, immediateScheduler, 7);
    const connecting = controller.connect(transport);
    await controller.disconnect();
    await connecting;
    expect(controller.connection.value).toBe('disconnected');
    expect(controller.session.value).toBeNull();
  });

  it('disconnects cleanly', async () => {
    const { controller } = await setup();
    await controller.disconnect();
    expect(controller.connection.value).toBe('disconnected');
  });

  it('suggests recalibrating when the IMU temperature moved more than 10 °C', async () => {
    const { controller } = await setup();
    await controller.capturePose('faceUp');
    await controller.capturePose('tipUp');
    const calibration = controller.calibration.value;
    if (!calibration) throw new Error('not calibrated');
    // The simulated v1 sensor reports no IMU temperature: nothing to compare.
    expect(calibration.temperatureC).toBeUndefined();
    expect(controller.temperatureWarning.value).toBe(false);
    controller.calibration.value = { ...calibration, temperatureC: 20 };
    const diagnostics = {
      protocolVersion: 2,
      firmwareVersion: '0.2.0',
      batteryPercent: 90,
      mode: 'M104' as const,
      payloadBytes: 48,
      temperatureC: 28,
      fifoOverruns: 0,
      droppedCaptures: 0,
      freeVars: 1000,
      errors: 0,
    };
    controller.diagnostics.value = diagnostics;
    expect(controller.temperatureWarning.value).toBe(false);
    controller.diagnostics.value = { ...diagnostics, temperatureC: 31 };
    expect(controller.temperatureWarning.value).toBe(true);
  });
});
