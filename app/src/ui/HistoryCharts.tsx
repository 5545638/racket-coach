import { useEffect, useState } from 'preact/hooks';
import type { CoachController } from '../app/controller';
import { LineChart, StackedBars } from './ChartParts';
import { type SessionHistory, sessionHistory } from './historyModel';
import { type ChartSpec, historyView } from './historyView';
import { reportStrings } from './reportStrings';

/**
 * "Ajalugu": charts over the last sessions. Loads lazily when it first
 * renders (the Profile tab opening) and keeps the result for the visit.
 */
export function HistoryCharts({ controller }: { readonly controller: CoachController }) {
  const language = controller.settings.value.language;
  const r = reportStrings(language);
  const [history, setHistory] = useState<SessionHistory | null>(null);

  useEffect(() => {
    let alive = true;
    void controller.loadHistory().then(({ sessions, strokes }) => {
      if (alive) setHistory(sessionHistory(sessions, strokes));
    });
    return () => {
      alive = false;
    };
  }, [controller]);

  if (history === null) {
    return (
      <section class="history">
        <h3>{r.historyTitle}</h3>
        <p class="hint">{r.historyLoading}</p>
      </section>
    );
  }
  const view = historyView(history, language);
  if (view.empty) {
    return (
      <section class="history">
        <h3>{r.historyTitle}</h3>
        <p class="hint">{r.historyEmpty}</p>
      </section>
    );
  }
  const common = (c: ChartSpec) => ({
    title: c.title,
    labels: c.labels,
    aria: c.aria,
    readout: c.readout,
    tapHint: r.tapHint,
    ticks: c.ticks,
    yFormat: (v: number) => `${Math.round(v)}${c.unit}`,
  });
  return (
    <section class="history">
      <h3>{r.historyTitle}</h3>
      <p class="note">{r.historyNote(history.sessions.length)}</p>
      <article class="card">
        <StackedBars
          {...common(view.strokes)}
          series={view.strokes.series}
          max={view.strokes.yMax}
        />
      </article>
      {view.speed.series.length > 0 && (
        <article class="card">
          <LineChart
            {...common(view.speed)}
            series={view.speed.series}
            yMin={view.speed.yMin}
            yMax={view.speed.yMax}
          />
          <p class="note">{r.speedNote}</p>
        </article>
      )}
      <article class="card">
        <LineChart
          {...common(view.consistency)}
          series={view.consistency.series}
          yMax={100}
          showLegend={false}
        />
        <p class="note">{r.consistencyNote}</p>
      </article>
      {view.faults.length > 0 && (
        <article class="card">
          <h4>{r.faultChart}</h4>
          {view.faults.map((c) => (
            <LineChart
              key={c.id}
              {...common(c)}
              series={c.series}
              yMax={c.yMax}
              showLegend={false}
              compact
            />
          ))}
        </article>
      )}
    </section>
  );
}
