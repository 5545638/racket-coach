import { signal } from '@preact/signals';
import type { CoachController } from '../app/controller';
import { focusOf } from '../coach/coachEngine';
import { FaceGauge } from './FaceGauge';
import { liveExtras, matchLiveView } from './profileViewModel';
import { strings } from './strings';
import { trainingStrings } from './trainingStrings';
import {
  bannerModels,
  detailsModel,
  guidanceDisplay,
  sessionStripModel,
  strokeCardModel,
} from './trainingViewModel';
import { type GuidanceBlocks, type MetricRow, liveViewModel } from './viewModel';
import './training.css';

/** Remembered across strokes and tab switches (the app is one page). */
const detailsOpen = signal(false);
const whyHowOpen = signal(false);

export function LiveView({ controller }: { readonly controller: CoachController }) {
  const language = controller.settings.value.language;
  const t = strings(language);
  const tt = trainingStrings(language);
  const stroke = controller.lastStroke.value;
  const strokes = controller.strokes.value;
  const count = strokes.length;
  const connected = controller.connection.value === 'connected';
  const mode = controller.settings.value.mode;
  const banners = bannerModels({
    connected,
    calibrated: controller.calibration.value !== null,
    temperatureWarning: controller.temperatureWarning.value,
    language,
  });
  const bannerEls = banners.length > 0 && (
    <div class="banners">
      {banners.map((b) => (
        <p key={b.kind} class={`banner ${b.kind}`} role="status">
          {b.text}
        </p>
      ))}
    </div>
  );

  if (!stroke) {
    const empty = strokeCardModel({
      metrics: null,
      count: 0,
      headline: null,
      assessment: null,
      language,
    });
    return (
      <section class="live training">
        {bannerEls}
        <div class="stroke-card empty">
          <p class={connected ? 'sc-title' : 'sc-hint'} aria-live="polite" aria-atomic="true">
            {empty.kind === 'empty' ? (connected ? empty.title : t.connectHint) : ''}
          </p>
          {empty.kind === 'empty' && connected && <p class="sc-hint">{empty.hint}</p>}
        </div>
      </section>
    );
  }

  const m = stroke.metrics;

  if (mode === 'match') {
    const match = matchLiveView({
      count,
      strokeType: m.strokeType,
      lastSpeech: controller.lastSpeech.value,
      language,
    });
    return (
      <section class="live training match">
        {bannerEls}
        <div class="match-card">
          <p class="match-count" aria-live="polite" aria-atomic="true">
            <span class="match-number">{match.count}</span>
            <span class="note">{t.live.matchStrokes}</span>
          </p>
          <p class="match-type">{tt.strokeType[m.strokeType]}</p>
          {match.pendingFault && (
            <p class="match-fault">
              <span class="note">{t.live.matchSpoken}</span>
              {match.pendingFault}
            </p>
          )}
        </div>
      </section>
    );
  }

  const extras = liveExtras({
    mode,
    utterance: controller.utterance.value,
    fatigueActive: controller.fatigueActive.value,
    categories: controller.categories.value,
    language,
  });
  const view = liveViewModel({
    metrics: m,
    assessment: controller.assessment.value,
    utterance: controller.utterance.value,
    cue: stroke.cue,
    focus: focusOf(controller.coachState.value, m.strokeType, m.swingStyle),
    baselineCount: controller.baselineCounts.value[m.strokeType],
    baselineLoading: controller.baselineLoading.value,
    language,
    dominantHand: controller.settings.value.dominantHand,
    history: strokes.map((s) => s.metrics),
  });
  const card = strokeCardModel({
    metrics: m,
    count,
    headline: view.headline,
    assessment: controller.assessment.value,
    language,
  });
  if (card.kind !== 'stroke') return null;
  const strip = sessionStripModel(strokes);
  const details = detailsModel(view.groups, language);
  const { focus } = view;
  const display = guidanceDisplay(mode);
  const showBlocks =
    view.blocks !== null && (display === 'open' || (display === 'collapsible' && whyHowOpen.value));
  // The face gauge describes topspin/flat drives only.
  const groundstroke = m.strokeType !== 'overhead' && m.swingStyle !== 'slice';

  return (
    <section class="live training">
      {bannerEls}

      <div class={`stroke-card ${card.verdict}`}>
        <div class="sc-head">
          <span class="sc-type">
            {card.strokeType}
            {card.qualifier && <span class="sc-qualifier"> · {card.qualifier}</span>}
          </span>
          <span class="sc-verdict">
            {card.verdictLabel.toLowerCase() === card.title.toLowerCase() ? '' : card.verdictLabel}
          </span>
          <span class="sc-count">{tt.strokeNo(card.count)}</span>
        </div>
        <p
          class={`sc-title ${card.positive ? 'positive' : ''}`}
          aria-live="polite"
          aria-atomic="true"
        >
          {/* Re-keyed per stroke so the CSS entrance animation runs again. */}
          <span class="sc-anim" key={count}>
            {card.title}
          </span>
        </p>
        <div class="sc-body" key={count}>
          {card.detail && <p class="sc-detail">{card.detail}</p>}
          {card.spoken && (
            <p class="sc-spoken">
              {tt.spoken}: „{card.spoken}“
            </p>
          )}
          {extras.learningLine && (
            <p class="sc-spoken">
              {t.live.learning}: „{extras.learningLine}“
            </p>
          )}
        </div>
        {(extras.fatigueBadge || extras.categoryLine) && (
          <p class="badges">
            {extras.fatigueBadge && <span class="badge fatigue">{extras.fatigueBadge}</span>}
            {extras.categoryLine && <span class="note">{extras.categoryLine}</span>}
          </p>
        )}
      </div>

      {view.blocks && display === 'collapsible' && (
        <button
          type="button"
          class="disclosure"
          aria-expanded={whyHowOpen.value}
          onClick={() => {
            whyHowOpen.value = !whyHowOpen.value;
          }}
        >
          <span>{tt.whyHow}</span>
          <Chevron open={whyHowOpen.value} />
        </button>
      )}
      {showBlocks && <Guidance blocks={view.blocks} t={t} />}

      <p class="focus-line">
        <span class="focus-label">{t.live.focus}</span>
        <span class="focus-title">{focus.title ?? t.live.noFocus}</span>
        {focus.confidencePercent !== null && (
          <span class="focus-conf">{focus.confidencePercent}%</span>
        )}
        {focus.statusText && <span class="note"> · {focus.statusText}</span>}
      </p>
      {view.rollHint && <p class="hint">{view.rollHint}</p>}

      <dl class="strip" aria-label={tt.strip.label}>
        <div class="strip-counts">
          <StripCell label={tt.strip.forehand} value={String(strip.counts.forehand)} />
          <StripCell label={tt.strip.backhand} value={String(strip.counts.backhand)} />
          <StripCell label={tt.strip.serve} value={String(strip.counts.overhead)} />
        </div>
        <div class="strip-stats">
          <StripCell label={tt.strip.last} value={strip.last} small />
          <StripCell label={tt.strip.average} value={strip.average} small />
          <StripCell label={tt.strip.good} value={strip.goodShare} small />
        </div>
      </dl>

      <button
        type="button"
        class="disclosure details-toggle"
        aria-expanded={detailsOpen.value}
        onClick={() => {
          detailsOpen.value = !detailsOpen.value;
        }}
      >
        <span>{tt.details}</span>
        <Chevron open={detailsOpen.value} />
      </button>
      {detailsOpen.value && (
        <div class="details">
          {details.baselineNote && <p class="note">{details.baselineNote}</p>}
          {focus.comparedWith && <p class="note">{focus.comparedWith}</p>}
          {view.baselineProgress && <p class="note">{view.baselineProgress}</p>}
          {m.faceTiltDeg !== null && groundstroke && <FaceGauge tiltDeg={m.faceTiltDeg} t={t} />}
          {details.groups.map((group) => (
            <div key={group.id}>
              <h3>{group.title}</h3>
              <dl class="metrics">
                {group.rows.map((row) => (
                  <Metric key={row.id} row={row} />
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Chevron({ open }: { readonly open: boolean }) {
  return (
    <svg
      class={open ? 'chevron open' : 'chevron'}
      viewBox="0 0 12 12"
      width="14"
      height="14"
      aria-hidden="true"
    >
      <path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.8" fill="none" />
    </svg>
  );
}

function StripCell({
  label,
  value,
  small = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly small?: boolean;
}) {
  return (
    <div class={small ? 'strip-cell small' : 'strip-cell'}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Guidance({
  blocks,
  t,
}: {
  readonly blocks: GuidanceBlocks;
  readonly t: ReturnType<typeof strings>;
}) {
  return (
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
