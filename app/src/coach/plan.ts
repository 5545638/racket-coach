import type { CorrectionId } from '../coaching/corrections';
import type { Language } from '../coaching/guidance';
import type { PhraseLevel } from '../domain/types';
import { cueVariant, drillText, weaknessLabel } from './phrases';
import type { LevelCounts, PlayerProfile, SessionProgress, Trend, Weakness } from './profile';

/**
 * Deterministic next-session training plan from the player profile
 * (docs/metrics.md, "Adaptive coach"). Pure; no network, no AI.
 */
export interface PlanConfig {
  /** Weaknesses in the plan. */
  readonly maxWeaknesses: number;
  readonly sets: number;
  readonly ballsPerSet: number;
  /** Maintenance item: sets × balls. */
  readonly maintenanceSets: number;
  /** Success: fault rate below max(this floor, current rate × `targetFactor`), rounded up to 5 %. */
  readonly targetFloor: number;
  readonly targetFactor: number;
  /** Maintenance: an element counts as improved when its fault rate fell by at least this. */
  readonly minImprovement: number;
}

export const DEFAULT_PLAN_CONFIG: PlanConfig = {
  maxWeaknesses: 2,
  sets: 3,
  ballsPerSet: 15,
  maintenanceSets: 1,
  targetFloor: 0.1,
  targetFactor: 0.5,
  minImprovement: 0.1,
};

export interface PlanItem {
  readonly kind: 'weakness' | 'maintenance';
  readonly correctionId: CorrectionId;
  readonly label: string;
  /** The catalogue drill, in the UI language. */
  readonly drill: string;
  readonly sets: number;
  readonly ballsPerSet: number;
  /** The cue variant with the most "Better"s (variant 0 when none). */
  readonly cue: string;
  readonly cueLevel: PhraseLevel;
  /** Success: fault rate below this on the next session (0–1). */
  readonly targetFaultRate: number;
  /** The fault rate the item starts from (0–1). */
  readonly currentFaultRate: number;
  readonly trend: Trend;
}

export interface TrainingPlan {
  readonly items: readonly PlanItem[];
  /** Rated strokes the profile was built on. */
  readonly basedOnStrokes: number;
}

/**
 * Optional, asynchronous refinement of a plan (e.g. a future AI that rewrites
 * the explanations). Never called in the real-time stroke loop; not
 * implemented. A plan must stay valid without it.
 */
export interface PlanEnhancer {
  enhance(
    plan: TrainingPlan,
    profile: PlayerProfile,
    options: { readonly language: Language; readonly signal?: AbortSignal },
  ): Promise<TrainingPlan>;
}

/** The variant with the most "Better"s; ties and no data → the lowest. */
export function bestLevel(counts: LevelCounts | undefined): PhraseLevel {
  if (!counts) return 0;
  let best: PhraseLevel = 0;
  for (const level of [1, 2] as const) if (counts[level] > counts[best]) best = level;
  return best;
}

const roundUpTo5 = (x: number): number => Math.ceil(x * 20 - 1e-9) / 20;

export function targetRate(current: number, config: PlanConfig = DEFAULT_PLAN_CONFIG): number {
  return roundUpTo5(Math.max(config.targetFloor, current * config.targetFactor));
}

const TREND_ORDER: Readonly<Record<Trend, number>> = { worsening: 0, stable: 1, improving: 2 };

/** Worsening first, then highest weight × fault rate; ties by correction id. */
export function rankWeaknesses(weaknesses: readonly Weakness[]): Weakness[] {
  return [...weaknesses].sort(
    (a, b) =>
      TREND_ORDER[a.trend] - TREND_ORDER[b.trend] ||
      b.weight * b.faultRate - a.weight * a.faultRate ||
      a.correctionId.localeCompare(b.correctionId),
  );
}

/** The correction whose fault rate fell most from its first to its latest session. */
export function bestImproved(
  progress: readonly SessionProgress[],
  exclude: ReadonlySet<CorrectionId>,
  minImprovement: number,
): { readonly correctionId: CorrectionId; readonly latest: number } | null {
  const first = new Map<CorrectionId, number>();
  const last = new Map<CorrectionId, number>();
  for (const s of progress) {
    for (const [id, rate] of Object.entries(s.corrections) as [CorrectionId, number][]) {
      if (!first.has(id)) first.set(id, rate);
      last.set(id, rate);
    }
  }
  let best: { correctionId: CorrectionId; latest: number; gain: number } | null = null;
  for (const [id, start] of first) {
    if (exclude.has(id)) continue;
    const latest = last.get(id) ?? start;
    const gain = start - latest;
    if (gain < minImprovement) continue;
    if (!best || gain > best.gain || (gain === best.gain && id < best.correctionId)) {
      best = { correctionId: id, latest, gain };
    }
  }
  return best && { correctionId: best.correctionId, latest: best.latest };
}

export function buildPlan(
  profile: PlayerProfile,
  language: Language = 'en',
  config: PlanConfig = DEFAULT_PLAN_CONFIG,
): TrainingPlan {
  const item = (
    kind: PlanItem['kind'],
    id: CorrectionId,
    current: number,
    trend: Trend,
    sets: number,
    target: number,
  ): PlanItem => {
    const level = bestLevel(profile.betterByLevel[id]);
    return {
      kind,
      correctionId: id,
      label: weaknessLabel(id, language),
      drill: drillText(id, language),
      sets,
      ballsPerSet: config.ballsPerSet,
      cue: cueVariant(id, level),
      cueLevel: level,
      targetFaultRate: target,
      currentFaultRate: current,
      trend,
    };
  };
  const chosen = rankWeaknesses(profile.weaknesses).slice(0, config.maxWeaknesses);
  const items: PlanItem[] = chosen.map((w) =>
    item(
      'weakness',
      w.correctionId,
      w.faultRate,
      w.trend,
      config.sets,
      targetRate(w.faultRate, config),
    ),
  );
  const improved = bestImproved(
    profile.progress,
    new Set(chosen.map((w) => w.correctionId)),
    config.minImprovement,
  );
  if (improved) {
    // Keep it there: no worse than now (at least the floor).
    const target = roundUpTo5(Math.max(config.targetFloor, improved.latest));
    items.push(
      item(
        'maintenance',
        improved.correctionId,
        improved.latest,
        'improving',
        config.maintenanceSets,
        target,
      ),
    );
  }
  return { items, basedOnStrokes: profile.ratedStrokes };
}
