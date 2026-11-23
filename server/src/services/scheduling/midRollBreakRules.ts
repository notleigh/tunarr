import type {
  BaseMidRollBreakRule,
  MidRollBreakRule,
  MidRollChapterType,
  MidRollConfig,
} from '@tunarr/types/api';

export type BreakPoint = { offsetMs: number };

/** A chapter marker of a program, with times in milliseconds. */
export type ChapterInfo = {
  startTime: number;
  endTime: number;
  chapterType: MidRollChapterType;
};

/**
 * The shortest break the config allows. A break cut down to fit a slot must
 * still be at least this long.
 */
export function minimumBreakDuration(config: MidRollConfig): number {
  return config.breakDurationMinMs ?? config.breakDurationMs ?? 0;
}

export function resolveBreakDuration(
  config: MidRollConfig,
  random?: { integer(min: number, max: number): number },
): number {
  if (
    config.breakDurationMinMs !== undefined &&
    config.breakDurationMaxMs !== undefined
  ) {
    if (!random) {
      return config.breakDurationMaxMs;
    }
    return random.integer(config.breakDurationMinMs, config.breakDurationMaxMs);
  }

  if (config.breakDurationMs === undefined) {
    throw new Error(
      'MidRollConfig must have either breakDurationMs or breakDurationMinMs/breakDurationMaxMs',
    );
  }

  return config.breakDurationMs;
}

function baseRuleOffsets(
  programDurationMs: number,
  breakRule: BaseMidRollBreakRule,
): number[] {
  switch (breakRule.type) {
    case 'fixed_interval': {
      const offsets: number[] = [];
      let offset = breakRule.intervalMs;
      while (offset < programDurationMs) {
        offsets.push(offset);
        offset += breakRule.intervalMs;
      }
      return offsets;
    }
    case 'percentage': {
      const offsets = breakRule.points.map((p) =>
        Math.round((programDurationMs * p) / 100),
      );
      offsets.sort((a, b) => a - b);
      return offsets;
    }
    case 'initial_then_interval': {
      const offsets: number[] = [];
      let offset = breakRule.initialDelayMs;
      while (offset < programDurationMs) {
        offsets.push(offset);
        offset += breakRule.intervalMs;
      }
      return offsets;
    }
  }
}

/**
 * Break offsets at the end of each chapter of the given types, except the
 * last. Returns null when the program has no chapters of those types.
 */
export function chapterBreakOffsets(
  programDurationMs: number,
  chapterTypes: MidRollChapterType[],
  chapters: ChapterInfo[] | undefined,
): number[] | null {
  const matching = (chapters ?? [])
    .filter((chapter) => chapterTypes.includes(chapter.chapterType))
    .sort((a, b) => a.startTime - b.startTime);

  if (matching.length === 0) return null;

  const offsets = new Set<number>();
  for (const chapter of matching.slice(0, -1)) {
    const offset = Math.round(chapter.endTime);
    if (offset > 0 && offset < programDurationMs) {
      offsets.add(offset);
    }
  }

  return [...offsets].sort((a, b) => a - b);
}

/**
 * Greedily drops offsets that start less than `minIntervalMs` after the
 * previous kept break, or after the program start.
 */
export function applyMinBreakInterval(
  offsets: number[],
  minIntervalMs: number | undefined,
): number[] {
  if (minIntervalMs === undefined || minIntervalMs <= 0) return offsets;
  const kept: number[] = [];
  let lastBreak = 0;
  for (const offset of offsets) {
    if (offset - lastBreak >= minIntervalMs) {
      kept.push(offset);
      lastBreak = offset;
    }
  }
  return kept;
}

export function resolveBreakPoints(
  programDurationMs: number,
  config: MidRollConfig,
  chapters?: ChapterInfo[],
): BreakPoint[] | null {
  if (programDurationMs < config.minProgramDurationMs) return null;

  let breakRule: MidRollBreakRule;
  if (config.breakRule) {
    breakRule = config.breakRule;
  } else if (config.intervalMs !== undefined) {
    breakRule = { type: 'fixed_interval', intervalMs: config.intervalMs };
  } else {
    throw new Error(
      'MidRollConfig must have either breakRule or intervalMs when enabled',
    );
  }

  let offsets: number[];

  switch (breakRule.type) {
    case 'fixed_interval':
    case 'percentage':
    case 'initial_then_interval':
      offsets = baseRuleOffsets(programDurationMs, breakRule);
      break;
    case 'chapters': {
      const chapterOffsets = chapterBreakOffsets(
        programDurationMs,
        breakRule.chapterTypes,
        chapters,
      );
      if (chapterOffsets) {
        offsets = chapterOffsets;
      } else if (breakRule.fallback) {
        offsets = baseRuleOffsets(programDurationMs, breakRule.fallback);
      } else {
        return null;
      }
      break;
    }
  }

  offsets = applyMinBreakInterval(offsets, config.minBreakIntervalMs);

  // Use max of range for conservative filtering
  const breakDuration = resolveBreakDuration(config);
  const tailBuffer = config.tailBufferMs ?? 0;

  offsets = offsets.filter(
    (offset) => programDurationMs - offset - breakDuration >= tailBuffer,
  );

  if (config.maxBreaks > 0) {
    offsets = offsets.slice(0, config.maxBreaks);
  }

  if (offsets.length === 0) return null;

  return offsets.map((offsetMs) => ({ offsetMs }));
}
