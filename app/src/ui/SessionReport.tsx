import type { CoachController } from '../app/controller';
import type { StrokeVerdict } from '../coaching/strokeFacts';
import { VERDICT_ORDER } from '../coaching/strokeFacts';
import {
  type Direction,
  REPORT_STROKE_TYPES,
  buildTrainingReport,
} from '../coaching/trainingReport';
import type { Language } from '../coaching/guidance';
import type { StrokeType } from '../domain/types';
import './report.css';
import { sessionAdaptive, planViews } from './profileViewModel';
import { type ReportStrings, reportStrings } from './reportStrings';
import { strings } from './strings';
import { titleFor } from './viewModel';

const percent = (share: number | null): string =>
  share === null ? '—' : `${Math.round(share * 100)}%`;

/** "42 min" / "1 h 05 min"; null without a duration. */
export function durationText(ms: number | null, r: ReportStrings): string | null {
  if (ms === null) return null;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes >= 60 ? r.hours(Math.floor(minutes / 60), minutes % 60) : r.minutes(minutes);
}

const dateText = (startedAt: number, language: Language): string =>
  new Date(startedAt).toLocaleString(language === 'et' ? 'et-EE' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

const ARROW = { up: '↑', down: '↓', flat: '→' } as const;
const arrow = (first: number | null, second: number | null): string => {
  if (first === null || second === null || first === second) return ARROW.flat;
  return second > first ? ARROW.up : ARROW.down;
};

function Trend({
  first,
  second,
  direction,
  r,
  format,
}: {
  readonly first: number | null;
  readonly second: number | null;
  readonly direction: Direction | null;
  readonly r: ReportStrings;
  readonly format: (v: number | null) => string;
}) {
  const label = direction === null ? r.noHalfData : r[direction];
  return (
    <span class={`trend-cell ${direction ?? 'same'}`}>
      <span class="halves">
        {format(first)} <span aria-hidden="true">→</span> {format(second)}
      </span>
      <span class="verdict">
        <span aria-hidden="true">
          {direction === null ? '' : direction === 'same' ? ARROW.flat : arrow(first, second)}
        </span>{' '}
        {label}
      </span>
    </span>
  );
}

function Meter({ value }: { readonly value: number }) {
  return (
    <span class="meter" aria-hidden="true">
      <span class="meter-fill" style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
    </span>
  );
}

export function SessionReport({ controller }: { readonly controller: CoachController }) {
  const language = controller.settings.value.language;
  const r = reportStrings(language);
  const t = strings(language);
  const session = controller.session.value;
  const strokes = controller.strokes.value;
  const report = buildTrainingReport(strokes);
  const adaptive = sessionAdaptive(strokes, language);
  const focus = planViews(controller.plan.value, language).find((p) => p.kind === 'weakness');
  const mode = report.mode ?? controller.settings.value.mode;
  const duration = durationText(report.durationMs, r);
  const typeName: Record<StrokeType, string> = r.totals;
  const verdictRows = VERDICT_ORDER.filter((v: StrokeVerdict) => report.verdicts[v] > 0);
  const speedTypes = REPORT_STROKE_TYPES.filter((ty) => report.speed[ty]);
  const consistencyTypes = REPORT_STROKE_TYPES.filter((ty) => report.consistency[ty]);

  return (
    <>
      <header class="report-head">
        <h2>{t.session.title}</h2>
        {session && <p class="report-date">{dateText(session.startedAt, language)}</p>}
        <p class="chips">
          {duration && (
            <span class="chip">
              {r.durationLabel} <b>{duration}</b>
            </span>
          )}
          <span class="chip">
            {r.modeLabel} <b>{r.mode[mode]}</b>
          </span>
        </p>
      </header>

      {report.totals.all === 0 ? (
        <p class="hint">{r.noStrokes}</p>
      ) : (
        <>
          <ul class="totals" aria-label={r.totals.all}>
            {(['all', ...REPORT_STROKE_TYPES] as const).map((key) => (
              <li key={key} class={key === 'all' ? 'total all' : 'total'}>
                <span class="big">{report.totals[key]}</span>
                <span class="label">{r.totals[key]}</span>
              </li>
            ))}
          </ul>

          <article class="card">
            <h3>
              {r.speedTitle} <span class="badge soft">{r.estimate}</span>
            </h3>
            {speedTypes.length === 0 ? (
              <p class="hint">{r.noSpeed}</p>
            ) : (
              <ul class="rows">
                {speedTypes.map((ty) => {
                  const s = report.speed[ty];
                  if (!s) return null;
                  return (
                    <li key={ty}>
                      <span class="row-name">{typeName[ty]}</span>
                      <span class="row-value">
                        {s.lowerBound ? (
                          <abbr title={r.lowerBound}>≥</abbr>
                        ) : (
                          <span class="est" aria-hidden="true">
                            ≈
                          </span>
                        )}
                        {Math.round(s.meanMps * 3.6)} <small>{r.speedUnit}</small>
                      </span>
                      <span class="row-note">{r.basedOn(s.n)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            <p class="note">
              {r.speedNote}
              {speedTypes.some((ty) => report.speed[ty]?.lowerBound) && ` ≥ ${r.lowerBound}.`}
            </p>
          </article>

          <article class="card">
            <h3>{r.consistencyTitle}</h3>
            {consistencyTypes.length === 0 ? (
              <p class="hint">{r.tooFew}</p>
            ) : (
              <ul class="rows">
                {consistencyTypes.map((ty) => {
                  const c = report.consistency[ty];
                  if (!c) return null;
                  const parts = (['face', 'path', 'speed'] as const)
                    .filter((k) => c.parts[k] !== null)
                    .map((k) => `${r.consistencyParts[k]} ${Math.round(c.parts[k] ?? 0)}`)
                    .join(' · ');
                  return (
                    <li key={ty} class="score-row">
                      <span class="row-name">{typeName[ty]}</span>
                      <span class="row-value">
                        {Math.round(c.score)}
                        <small> /100</small>
                      </span>
                      <Meter value={c.score} />
                      <span class="row-note">
                        {r.basedOn(c.n)} · {parts}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <p class="note">{r.consistencyNote}</p>
          </article>

          <article class="card">
            <h3>{r.strengthsTitle}</h3>
            {report.strengths.length === 0 ? (
              <p class="hint">{r.strengthsEmpty}</p>
            ) : (
              <ul class="rows good">
                {report.strengths.map((s) => (
                  <li key={s.correctionId}>
                    <span class="row-title">
                      <span class="tick-ok" aria-hidden="true">
                        ✓
                      </span>{' '}
                      {r.strength[s.correctionId]}
                    </span>
                    <Meter value={s.share * 100} />
                    <span class="row-note">{r.inBand(s.share, s.assessed)}</span>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article class="card">
            <h3>{r.errorsTitle}</h3>
            {report.errors.length === 0 ? (
              <p class="hint">{r.errorsEmpty}</p>
            ) : (
              <ul class="rows fix">
                {report.errors.map((e) => (
                  <li key={e.correctionId}>
                    <span class="row-title">{titleFor(e.correctionId, language)}</span>
                    <Meter value={e.share * 100} />
                    <span class="row-note">{r.errorShare(e.share, e.count)}</span>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article class="card">
            <h3>{r.improvementTitle}</h3>
            {!report.improvement.enough ? (
              <p class="hint">{r.tooFewStrokes}</p>
            ) : (
              <>
                <p class="note halves-head">
                  {r.firstHalf} <span aria-hidden="true">→</span> {r.secondHalf}
                </p>
                <ul class="rows trend-rows">
                  {report.improvement.errors.map((e) => (
                    <li key={e.correctionId}>
                      <span class="row-title">
                        {titleFor(e.correctionId, language)}
                        <small class="muted"> · {r.faultRate}</small>
                      </span>
                      <Trend
                        first={e.first}
                        second={e.second}
                        direction={e.direction}
                        r={r}
                        format={percent}
                      />
                    </li>
                  ))}
                  {report.improvement.consistency && (
                    <li>
                      <span class="row-title">{r.consistencyTitle}</span>
                      <Trend
                        first={report.improvement.consistency.first}
                        second={report.improvement.consistency.second}
                        direction={
                          report.improvement.consistency.direction === null
                            ? null
                            : report.improvement.consistency.direction
                        }
                        r={r}
                        format={(v) => (v === null ? '—' : String(Math.round(v)))}
                      />
                    </li>
                  )}
                </ul>
                <p class="note">{r.improvementNote}</p>
              </>
            )}
          </article>

          <article class="card coach">
            <h3>{r.focusTitle}</h3>
            {focus ? (
              <>
                <p class="cue fix small">{focus.title}</p>
                <p class="plan-volume">{focus.volume}</p>
                <dl class="guidance">
                  <dt>{r.drill}</dt>
                  <dd>{focus.drill}</dd>
                </dl>
                <p class="plan-target">{focus.target}</p>
              </>
            ) : (
              <p class="hint">{r.focusEmpty}</p>
            )}
          </article>

          <article class="card">
            <h3>{r.verdictTitle}</h3>
            <ul class="tally">
              {verdictRows.map((v) => (
                <li key={v}>
                  {r.verdict[v]} <span class="count">{report.verdicts[v]}</span>
                </li>
              ))}
            </ul>
            {adaptive.feedback.some((f) => f.count > 0) && (
              <>
                <h3>{r.feedbackTitle}</h3>
                <ul class="tally stacked">
                  {adaptive.feedback
                    .filter((f) => f.count > 0)
                    .map((f) => (
                      <li key={f.kind}>
                        {f.label} <span class="count">{f.count}×</span>
                      </li>
                    ))}
                </ul>
              </>
            )}
          </article>
        </>
      )}
    </>
  );
}
