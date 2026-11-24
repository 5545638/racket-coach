import { EMPTY_BASELINE, type PersonalBaseline, buildBaseline } from '../../src/coach/baseline';
import { classifyStroke } from '../../src/coach/classify';
import {
  type CoachConfig,
  type CoachState,
  type CoachStep,
  DEFAULT_COACH_CONFIG,
  INITIAL_COACH_STATE,
  coachStep,
} from '../../src/coach/coachEngine';
import {
  type FatigueState,
  initialFatigue,
  isFatigued,
  updateFatigue,
} from '../../src/coach/fatigue';
import { type CoachingPolicy, coachingPolicy } from '../../src/coach/profile';
import type {
  CoachMode,
  PlayerInputs,
  StrokeCoaching,
  StrokeMetrics,
  StrokeRecord,
} from '../../src/domain/types';
import { assessStroke } from '../../src/elements/assess';
import { DEFAULT_PLAYER_INPUTS } from '../../src/coach/profile';
import { strokeRecord } from '../fixtures';

export interface Played {
  readonly step: CoachStep;
  /** What was said now ('—' for nothing). */
  readonly said: string;
}

export interface Run {
  readonly played: Played[];
  readonly state: CoachState;
  readonly fatigue: FatigueState;
  /** One readable line per stroke: "label → speech". */
  readonly table: string[];
}

export interface StrokeRow {
  readonly label: string;
  readonly metrics: StrokeMetrics;
  /** capture.receivedAt, ms. */
  readonly at?: number;
}

/**
 * Plays strokes through the profile policy, the fatigue detector and the
 * coach, as the controller does (without the baseline growing per stroke).
 */
export function play(
  rows: readonly StrokeRow[],
  options: {
    readonly mode?: CoachMode;
    readonly inputs?: Partial<PlayerInputs>;
    readonly baseline?: PersonalBaseline;
    readonly config?: Partial<CoachConfig>;
    readonly state?: CoachState;
    readonly fatigue?: FatigueState;
    /** Use the fatigue detector (needs `at` on every row). */
    readonly detectFatigue?: boolean;
  } = {},
): Run {
  const policy = coachingPolicy({ ...DEFAULT_PLAYER_INPUTS, ...options.inputs });
  const config = { ...DEFAULT_COACH_CONFIG, ...options.config };
  let state = options.state ?? INITIAL_COACH_STATE;
  let fatigue = options.fatigue ?? initialFatigue();
  const played: Played[] = [];
  const table: string[] = [];
  for (const row of rows) {
    const assessment = assessStroke(
      row.metrics,
      options.baseline ?? EMPTY_BASELINE,
      policy.assess,
      policy.catalog,
    );
    if (options.detectFatigue && row.at !== undefined) {
      fatigue = updateFatigue(fatigue, row.metrics, assessment, row.at);
    }
    const step = coachStep(state, assessment, config, true, {
      mode: options.mode ?? 'training',
      receivedAt: row.at ?? null,
      fatigueActive: isFatigued(fatigue, row.metrics.strokeType),
    });
    state = step.state;
    const said = step.speech ?? '—';
    played.push({ step, said });
    table.push(`${row.label} → ${said}`);
  }
  return { played, state, fatigue, table };
}

/** `n` rows with the same metrics. */
export const rows = (n: number, label: string, metrics: StrokeMetrics, start = 0, everyMs = 5000) =>
  Array.from({ length: n }, (_, i): StrokeRow => ({ label, metrics, at: (start + i) * everyMs }));

/** A personal baseline built with the player's policy from metrics (oldest first). */
export function baselineFrom(
  history: readonly StrokeMetrics[],
  inputs: Partial<PlayerInputs> = {},
): PersonalBaseline {
  const policy = coachingPolicy({ ...DEFAULT_PLAYER_INPUTS, ...inputs });
  const records = history.map((m, i) => strokeRecord(m, i + 1));
  return buildBaseline(records, undefined, undefined, policy.baselineCatalog);
}

/**
 * A stored stroke with the coaching outcome the controller would keep: its
 * categories from a population-only assessment.
 */
export function coachedRecord(
  metrics: StrokeMetrics,
  sessionId: string,
  receivedAt: number,
  coach: Partial<StrokeCoaching> = {},
  policy: CoachingPolicy = coachingPolicy(),
): StrokeRecord {
  const assessment = assessStroke(metrics, EMPTY_BASELINE, policy.assess, policy.catalog);
  const categories = classifyStroke(assessment, {
    fatigueActive: false,
    focusBefore: null,
    improved: false,
  });
  return {
    ...strokeRecord(metrics, receivedAt),
    id: `${sessionId}-${String(receivedAt)}`,
    sessionId,
    coach: {
      utterance: 'silent',
      correctionId: null,
      focus: null,
      mode: 'training',
      categories,
      phraseLevel: null,
      fatigueActive: false,
      ...coach,
    },
  };
}
