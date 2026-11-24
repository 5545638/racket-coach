import type { CoachController } from '../app/controller';
import { toCsv, toJson } from '../app/export';
import { buildSessionReport } from '../coaching/sessionReport';
import { type Statistic, summarize } from '../coaching/summary';
import { strings } from './strings';
import { guidanceBlocks, sessionCoachSummary, titleFor } from './viewModel';

/**
 * Hands a file to the user. Uses the share sheet where available (iOS web
 * views ignore the download attribute) and falls back to a download link.
 */
async function saveFile(filename: string, content: string, type: string): Promise<void> {
  const file = new File([content], filename, { type });
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}

const stat = (s: Statistic | null, unit: string, factor = 1): string =>
  s ? `${(s.mean * factor).toFixed(0)} ± ${(s.sd * factor).toFixed(0)}${unit}` : '—';

const percent = (share: number): string => `${(share * 100).toFixed(0)}%`;

export function SessionView({ controller }: { readonly controller: CoachController }) {
  const language = controller.settings.value.language;
  const t = strings(language);
  const session = controller.session.value;
  const strokes = controller.strokes.value;
  const summaries = summarize(strokes);
  const report = buildSessionReport(strokes);
  const coach = sessionCoachSummary(strokes);
  const focused = coach.filter((c) => c.focus !== null);
  const stamp = session ? new Date(session.startedAt).toISOString().slice(0, 16) : 'session';

  return (
    <section class="session">
      <h2>
        {t.session.title}
        {session ? ` · ${session.label}` : ''}
      </h2>
      <p class="hint">{t.session.strokes(report.totalStrokes, report.unrated)}</p>

      <article class="card coach">
        <h3>{t.session.focusTitle}</h3>
        {focused.length > 0 ? (
          focused.map((c) => {
            const blocks = c.focus ? guidanceBlocks(c.focus, language) : null;
            return (
              <div key={c.strokeType}>
                <h4>{t.stroke[c.strokeType]}</h4>
                <p class="cue fix small">{c.focus ? titleFor(c.focus, language) : ''}</p>
                {blocks && (
                  <dl class="guidance">
                    <dt>{t.live.change}</dt>
                    <dd>{blocks.change}</dd>
                    <dt>{t.live.drill}</dt>
                    <dd>{blocks.drill}</dd>
                  </dl>
                )}
              </div>
            );
          })
        ) : (
          <p class="hint">{t.session.noFocus}</p>
        )}
      </article>

      {summaries.map((s) => {
        const own = coach.find((c) => c.strokeType === s.strokeType);
        return (
          <article key={s.strokeType} class="card">
            <h3>
              {t.stroke[s.strokeType]} <span class="count">{s.count}</span>
            </h3>
            <dl class="metrics">
              <div class="metric">
                <dt>{t.session.good}</dt>
                <dd>{percent(s.goodShare)}</dd>
              </div>
              <div class="metric">
                <dt>{t.metric.face}</dt>
                <dd>{stat(s.faceTiltDeg, '°')}</dd>
              </div>
              <div class="metric">
                <dt>{t.metric.path}</dt>
                <dd>{stat(s.swingPathDeg, '°')}</dd>
              </div>
              <div class="metric">
                <dt>{t.metric.speed}</dt>
                <dd>{stat(s.headSpeedMps, ' km/h', 3.6)}</dd>
              </div>
            </dl>
            {own && (
              <>
                <p class="pill-row">
                  <span>{t.session.counted(own.counted)}</span>
                  <span>{t.session.betterTimes(own.better)}</span>
                  <span>{t.session.thatsItTimes(own.keepIt)}</span>
                </p>
                <h4>{t.session.corrections}</h4>
                {own.corrections.length > 0 ? (
                  <ul class="faults corrections">
                    {own.corrections.slice(0, 3).map((c) => (
                      <li key={c.correctionId}>
                        {titleFor(c.correctionId, language)} <span class="count">{c.count}×</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p class="hint">{t.session.noCorrections}</p>
                )}
                {own.focus && (
                  <p class="note">
                    {t.session.focusNow}: {titleFor(own.focus, language)}
                  </p>
                )}
              </>
            )}
          </article>
        );
      })}
      <p class="hint">{t.session.spread}</p>

      <div class="actions">
        <button
          type="button"
          disabled={!session || strokes.length === 0}
          onClick={() => {
            void saveFile(`racket-coach-${stamp}.csv`, toCsv(strokes), 'text/csv');
          }}
        >
          {t.session.exportCsv}
        </button>
        <button
          type="button"
          disabled={!session || strokes.length === 0}
          onClick={() => {
            if (session) {
              void saveFile(
                `racket-coach-${stamp}.json`,
                toJson(session, strokes),
                'application/json',
              );
            }
          }}
        >
          {t.session.exportRaw}
        </button>
        <button
          type="button"
          onClick={() => {
            void controller.startSession();
          }}
        >
          {t.session.newSession}
        </button>
      </div>

      {controller.log.value.length > 0 && (
        <details class="log">
          <summary>{t.session.diagnostics}</summary>
          <ul>
            {controller.log.value.map((entry) => (
              <li key={entry.id}>{entry.text}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
