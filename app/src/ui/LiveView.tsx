import type { CoachController } from '../app/controller';
import { STROKE_LABEL, deg, kmh, ms } from './format';

/** Literature target bands shown next to each value; see docs/metrics.md. */
const TARGETS = {
  face: '−20…−5°',
  path: '17…48°',
  timing: '≈ 0 ms',
} as const;

export function LiveView({ controller }: { readonly controller: CoachController }) {
  const stroke = controller.lastStroke.value;
  const count = controller.strokes.value.length;

  if (!controller.calibration.value && controller.connection.value === 'connected') {
    return <p class="hint">Calibrate the sensor in Setup before hitting.</p>;
  }
  if (!stroke) {
    return (
      <p class="hint">
        {controller.connection.value === 'connected'
          ? 'Waiting for the first stroke…'
          : 'Connect the sensor, or try Demo.'}
      </p>
    );
  }

  const m = stroke.metrics;
  const groundstroke = m.strokeType !== 'overhead';
  return (
    <section class="live" aria-live="polite">
      <p class="stroke-type">
        {STROKE_LABEL[m.strokeType]}
        {m.swingSize === 'compact' && ' · compact'}
        <span class="count">#{count}</span>
      </p>
      <p class={`cue ${stroke.cue.severity}`}>{stroke.cue.text}</p>

      <dl class="metrics">
        <Metric label="Racket speed" value={kmh(m.headSpeedMps, m.quality.gyroSaturated)} />
        <Metric
          label="Face"
          value={deg(m.faceTiltDeg)}
          target={groundstroke ? TARGETS.face : null}
        />
        <Metric
          label="Swing path"
          value={deg(m.swingPathDeg)}
          target={groundstroke ? TARGETS.path : null}
        />
        <Metric label="Peak speed" value={ms(m.peakSpeedOffsetMs)} target={TARGETS.timing} />
        <Metric label="Forward swing" value={deg(m.forwardSwingArcDeg)} target={null} />
        <Metric label="Follow-through" value={deg(m.followThroughArcDeg)} target={null} />
      </dl>

      {!m.impactDetected && <p class="note">No ball contact detected.</p>}
      {!m.quality.attitudeReliable && (
        <p class="note">Angles unavailable: hold the racket still for a moment before swinging.</p>
      )}
    </section>
  );
}

function Metric(props: { label: string; value: string; target?: string | null }) {
  return (
    <div class="metric">
      <dt>{props.label}</dt>
      <dd>
        {props.value}
        {props.target && <span class="target">target {props.target}</span>}
      </dd>
    </div>
  );
}
