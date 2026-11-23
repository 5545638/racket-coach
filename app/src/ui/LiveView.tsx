import type { CoachController } from '../app/controller';
import { guidanceFor } from '../coaching/guidance';
import { FaceGauge } from './FaceGauge';
import { deg, dps, kmh, ms } from './format';
import { strings } from './strings';

/** Literature target bands shown next to each value; see docs/metrics.md. */
const TARGETS = {
  face: '−20…−5°',
  path: '17…48°',
  timing: '≈ 0 ms',
} as const;

export function LiveView({ controller }: { readonly controller: CoachController }) {
  const language = controller.settings.value.language;
  const t = strings(language);
  const stroke = controller.lastStroke.value;
  const count = controller.strokes.value.length;
  const connected = controller.connection.value === 'connected';

  if (!controller.calibration.value && connected) {
    return <p class="hint">{t.calibrateFirst}</p>;
  }
  if (!stroke) {
    return <p class="hint">{connected ? t.waiting : t.connectHint}</p>;
  }

  const m = stroke.metrics;
  const groundstroke = m.strokeType !== 'overhead';
  const guidance = guidanceFor(stroke.cue.ruleId, language);
  const target = (band: string): string | null => (groundstroke ? `${t.target} ${band}` : null);

  return (
    <section class="live" aria-live="polite">
      <p class="stroke-type">
        <span>
          {t.stroke[m.strokeType]}
          {m.swingSize === 'compact' && ` · ${t.compact}`}
        </span>
        <span class="count">#{count}</span>
      </p>
      <p class={`cue ${stroke.cue.severity}`}>{stroke.cue.text}</p>

      {guidance && (
        <dl class="guidance">
          <dt>{t.meaning}</dt>
          <dd>{guidance.meaning}</dd>
          <dt>{t.fix}</dt>
          <dd>{guidance.fix}</dd>
        </dl>
      )}

      {m.faceTiltDeg !== null && groundstroke && <FaceGauge tiltDeg={m.faceTiltDeg} t={t} />}
      {!m.impactDetected && <p class="note">{t.noContact}</p>}

      <h3>{t.group.preparation}</h3>
      <dl class="metrics">
        <Metric label={t.metric.preparationTime} value={ms(m.preparationTimeMs, false)} />
        <Metric label={t.metric.backswing} value={deg(m.backswingArcDeg)} />
        <Metric label={t.metric.racketDrop} value={deg(m.racketDropDeg)} />
        <Metric label={t.metric.faceAtDrop} value={deg(m.faceAtDropDeg)} />
        <Metric label={t.metric.pause} value={ms(m.backswingPauseMs, false)} />
        <Metric label={t.metric.forwardSwing} value={deg(m.forwardSwingArcDeg)} />
      </dl>

      <h3>{t.group.contact}</h3>
      <dl class="metrics">
        <Metric label={t.metric.speed} value={kmh(m.headSpeedMps, m.quality.gyroSaturated)} />
        <Metric label={t.metric.face} value={deg(m.faceTiltDeg)} note={target(TARGETS.face)} />
        <Metric label={t.metric.path} value={deg(m.swingPathDeg)} note={target(TARGETS.path)} />
        <Metric
          label={t.metric.peakSpeed}
          value={ms(m.peakSpeedOffsetMs)}
          note={`${t.target} ${TARGETS.timing}`}
        />
        <Metric label={t.metric.whip} value={ms(m.peakAccelerationOffsetMs)} />
        <Metric label={t.metric.faceClosing} value={dps(m.faceClosingRateDps)} />
      </dl>

      <h3>{t.group.finish}</h3>
      <dl class="metrics">
        <Metric label={t.metric.followThrough} value={deg(m.followThroughArcDeg)} />
      </dl>
    </section>
  );
}

function Metric(props: {
  readonly label: string;
  readonly value: string;
  readonly note?: string | null;
}) {
  return (
    <div class="metric">
      <dt>{props.label}</dt>
      <dd>
        {props.value}
        {props.note && <span class="target">{props.note}</span>}
      </dd>
    </div>
  );
}
