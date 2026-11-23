import type { CoachController } from '../app/controller';
import { toCsv, toJson } from '../app/export';
import { type Statistic, summarize } from '../coaching/summary';
import { STROKE_LABEL } from './format';

function download(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const stat = (s: Statistic | null, unit: string, factor = 1): string =>
  s ? `${(s.mean * factor).toFixed(0)} ± ${(s.sd * factor).toFixed(0)}${unit}` : '—';

export function SessionView({ controller }: { readonly controller: CoachController }) {
  const session = controller.session.value;
  const strokes = controller.strokes.value;
  const summaries = summarize(strokes);
  const stamp = session ? new Date(session.startedAt).toISOString().slice(0, 16) : 'session';

  return (
    <section class="session">
      <h2>Session {session ? `· ${session.label}` : ''}</h2>
      <p class="hint">
        {strokes.length} strokes. “±” is the spread: smaller means more consistent.
      </p>

      {summaries.map((s) => (
        <article key={s.strokeType} class="card">
          <h3>
            {STROKE_LABEL[s.strokeType]} <span class="count">{s.count}</span>
          </h3>
          <dl class="metrics">
            <div class="metric">
              <dt>Good</dt>
              <dd>{(s.goodShare * 100).toFixed(0)}%</dd>
            </div>
            <div class="metric">
              <dt>Face</dt>
              <dd>{stat(s.faceTiltDeg, '°')}</dd>
            </div>
            <div class="metric">
              <dt>Swing path</dt>
              <dd>{stat(s.swingPathDeg, '°')}</dd>
            </div>
            <div class="metric">
              <dt>Speed</dt>
              <dd>{stat(s.headSpeedMps, ' km/h', 3.6)}</dd>
            </div>
          </dl>
          {s.topFault && (
            <p class="note">
              Most common: {s.topFault.text} ({s.topFault.count}×)
            </p>
          )}
        </article>
      ))}

      <div class="actions">
        <button
          type="button"
          disabled={!session || strokes.length === 0}
          onClick={() => {
            download(`racket-coach-${stamp}.csv`, toCsv(strokes), 'text/csv');
          }}
        >
          Export CSV
        </button>
        <button
          type="button"
          disabled={!session || strokes.length === 0}
          onClick={() => {
            if (session)
              download(`racket-coach-${stamp}.json`, toJson(session, strokes), 'application/json');
          }}
        >
          Export raw data
        </button>
        <button
          type="button"
          onClick={() => {
            void controller.startSession();
          }}
        >
          New session
        </button>
      </div>

      {controller.log.value.length > 0 && (
        <details class="log">
          <summary>Diagnostics</summary>
          <ul>
            {controller.log.value.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
