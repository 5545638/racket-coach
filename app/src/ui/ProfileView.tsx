import type { CoachController } from '../app/controller';
import { type ProgressView, profileViewModel } from './profileViewModel';
import { strings } from './strings';

function Spark({ item }: { readonly item: ProgressView }) {
  const { spark } = item;
  const last = spark.points.at(-1);
  return (
    <svg
      class="spark"
      viewBox={`0 0 ${spark.width} ${spark.height}`}
      role="img"
      aria-label={item.aria}
    >
      <line
        class="spark-base"
        x1="0"
        y1={spark.height - 5}
        x2={spark.width}
        y2={spark.height - 5}
      />
      {spark.path && <path class="spark-line" d={spark.path} />}
      {spark.points.map((p, i) => (
        <circle
          key={i}
          class={p === last ? 'spark-dot last' : 'spark-dot'}
          cx={p.x}
          cy={p.y}
          r="3"
        />
      ))}
    </svg>
  );
}

export function ProfileView({
  controller,
  onOpenSettings,
}: {
  readonly controller: CoachController;
  readonly onOpenSettings: () => void;
}) {
  const language = controller.settings.value.language;
  const t = strings(language);
  const p = t.profile;
  const view = profileViewModel(controller.profile.value, controller.plan.value, language);

  return (
    <section class="profile">
      <h2>{p.title}</h2>
      {view.empty && <p class="hint">{p.empty}</p>}

      <article class="card">
        <h3>{p.inputs}</h3>
        <dl class="metrics">
          {view.inputs.map((row) => (
            <div key={row.id} class="metric">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
        <p>
          <button type="button" onClick={onOpenSettings}>
            {p.change}
          </button>
        </p>
      </article>

      <h3>{p.typical}</h3>
      {view.typical.length === 0 && <p class="hint">{p.noTypical}</p>}
      {view.typical.map((s) => (
        <article key={s.strokeType} class="card">
          <h4>
            {s.title} <span class="count">{p.typicalStrokes(s.n)}</span>
          </h4>
          <dl class="metrics">
            {s.rows.map((row) => (
              <div key={row.id} class="metric">
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </article>
      ))}

      <h3>{p.weaknesses}</h3>
      {view.weaknesses.length === 0 ? (
        <p class="hint">{view.empty ? p.empty : p.noWeaknesses}</p>
      ) : (
        <ul class="card plain weak-list">
          {view.weaknesses.map((w) => (
            <li key={w.correctionId}>
              <span class="weak-name">
                {w.label}
                {w.newBadge && <span class="badge"> {w.newBadge}</span>}
              </span>
              <span class="weak-rate">
                {w.rate} {p.faultRate}
              </span>
              <span class="note">{w.sessionsText}</span>
              <span class={`trend ${w.trend}`}>
                <span aria-hidden="true">{w.arrow}</span> {w.trendLabel}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3>{p.progress}</h3>
      {view.progress.length === 0 ? (
        <p class="hint">{p.noProgress}</p>
      ) : (
        <article class="card">
          {view.progress.map((item) => (
            <div key={item.correctionId} class="spark-row">
              <p class="spark-name">{item.label}</p>
              <Spark item={item} />
            </div>
          ))}
          <p class="note">{p.sparkHint}</p>
        </article>
      )}

      <h3>{p.plan}</h3>
      {view.plan.length === 0 ? (
        <p class="hint">{view.empty ? p.empty : p.noPlan}</p>
      ) : (
        view.plan.map((item) => (
          <article key={`${item.kind}-${item.correctionId}`} class="card">
            <p class="note">{item.kindLabel}</p>
            <h4>{item.title}</h4>
            <p class="plan-volume">{item.volume}</p>
            <dl class="guidance">
              <dt>{p.drill}</dt>
              <dd>{item.drill}</dd>
              <dt>{p.bestCue}</dt>
              <dd>„{item.cue}“</dd>
            </dl>
            <p class="plan-target">{item.target}</p>
          </article>
        ))
      )}
      {view.ratedStrokes > 0 && <p class="note">{p.basedOn(view.ratedStrokes)}</p>}
    </section>
  );
}
