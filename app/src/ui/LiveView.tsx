import type { CoachController } from '../app/controller';
import { FaceGauge } from './FaceGauge';
import { strings } from './strings';
import { type MetricRow, liveViewModel } from './viewModel';

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
  const view = liveViewModel({
    metrics: m,
    assessment: controller.assessment.value,
    utterance: controller.utterance.value,
    cue: stroke.cue,
    focus: controller.focus.value[m.strokeType],
    baselineCount: controller.baselineCounts.value[m.strokeType],
    baselineLoading: controller.baselineLoading.value,
    language,
  });
  const { headline, blocks, focus } = view;
  // The face gauge describes topspin/flat drives only.
  const groundstroke = m.strokeType !== 'overhead' && m.swingStyle !== 'slice';

  return (
    <section class="live">
      <p class="stroke-type">
        <span>
          {t.stroke[m.strokeType]}
          {m.swingStyle === 'slice' && ` · ${t.slice}`}
          {m.swingSize === 'compact' && ` · ${t.compact}`}
        </span>
        <span class="count">#{count}</span>
      </p>

      <p class={`cue ${headline.tone}`} aria-live="polite" aria-atomic="true">
        {headline.title}
      </p>
      {headline.spoken && headline.spoken !== headline.title && (
        <p class="spoken">
          {t.live.voice}: „{headline.spoken}“
        </p>
      )}
      {headline.detail && <p class="detail">{headline.detail}</p>}

      {blocks && (
        <dl class="guidance">
          <dt>{t.live.why}</dt>
          <dd>{blocks.why}</dd>
          {blocks.change && (
            <>
              <dt>{t.live.change}</dt>
              <dd>{blocks.change}</dd>
            </>
          )}
          {blocks.drill && (
            <>
              <dt>{t.live.drill}</dt>
              <dd>{blocks.drill}</dd>
            </>
          )}
        </dl>
      )}

      <div class="focus">
        <p class="focus-line">
          <span class="focus-label">{t.live.focus}</span>
          {focus.title ?? t.live.noFocus}
          {focus.statusText && <span class="note"> · {focus.statusText}</span>}
        </p>
        {focus.confidencePercent !== null && (
          <p class="note">{t.live.confidence(focus.confidencePercent)}</p>
        )}
        {focus.comparedWith && <p class="note">{focus.comparedWith}</p>}
        {view.baselineProgress && <p class="note">{view.baselineProgress}</p>}
      </div>

      {m.faceTiltDeg !== null && groundstroke && <FaceGauge tiltDeg={m.faceTiltDeg} t={t} />}

      {view.groups.map((group) => (
        <div key={group.id}>
          <h3>{group.title}</h3>
          <dl class="metrics">
            {group.rows.map((row) => (
              <Metric key={row.id} row={row} />
            ))}
          </dl>
        </div>
      ))}
    </section>
  );
}

function Metric({ row }: { readonly row: MetricRow }) {
  return (
    <div
      class={`metric ${row.status}`}
      title={row.status === 'not-assessable' ? (row.note ?? undefined) : undefined}
    >
      <dt>{row.label}</dt>
      <dd>
        {row.value}
        {row.note && <span class="target">{row.note}</span>}
      </dd>
    </div>
  );
}
