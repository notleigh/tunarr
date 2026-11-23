import type { MidRollConfig } from '@tunarr/types/api';
import { describe, expect, test } from 'vitest';
import type { ChapterInfo } from './midRollBreakRules.ts';
import {
  applyMinBreakInterval,
  chapterBreakOffsets,
  resolveBreakPoints,
} from './midRollBreakRules.ts';

const oneMin = 60 * 1000;

function config(overrides: Partial<MidRollConfig>): MidRollConfig {
  return {
    strategy: 'eager',
    breakDurationMs: oneMin,
    maxBreaks: 0,
    minProgramDurationMs: 0,
    tailBufferMs: 0,
    breakRule: { type: 'chapters', chapterTypes: ['chapter'] },
    ...overrides,
  };
}

function chapter(
  startMin: number,
  endMin: number,
  chapterType: ChapterInfo['chapterType'] = 'chapter',
): ChapterInfo {
  return {
    startTime: startMin * oneMin,
    endTime: endMin * oneMin,
    chapterType,
  };
}

function offsetsMin(points: { offsetMs: number }[] | null) {
  return points?.map((p) => p.offsetMs / oneMin) ?? null;
}

const fourActs = [
  chapter(0, 10),
  chapter(10, 20),
  chapter(20, 30),
  chapter(30, 40),
];

describe('resolveBreakPoints with the chapters rule', () => {
  test('breaks at the end of each chapter except the last', () => {
    expect(
      offsetsMin(resolveBreakPoints(40 * oneMin, config({}), fourActs)),
    ).toEqual([10, 20, 30]);
  });

  test('sorts chapters by start time', () => {
    const shuffled = [fourActs[2]!, fourActs[0]!, fourActs[3]!, fourActs[1]!];
    expect(
      offsetsMin(resolveBreakPoints(40 * oneMin, config({}), shuffled)),
    ).toEqual([10, 20, 30]);
  });

  test('only uses chapters of the selected types', () => {
    const withMarkers = [
      ...fourActs,
      chapter(1, 2, 'intro'),
      chapter(38, 40, 'outro'),
    ];
    expect(
      offsetsMin(resolveBreakPoints(40 * oneMin, config({}), withMarkers)),
    ).toEqual([10, 20, 30]);

    expect(
      offsetsMin(
        resolveBreakPoints(
          40 * oneMin,
          config({
            breakRule: { type: 'chapters', chapterTypes: ['chapter', 'intro'] },
          }),
          withMarkers,
        ),
      ),
    ).toEqual([2, 10, 20, 30]);
  });

  test('a single chapter spanning the program gives no breaks', () => {
    expect(
      resolveBreakPoints(40 * oneMin, config({}), [chapter(0, 40)]),
    ).toBeNull();
  });

  test('returns null without chapters and without a fallback', () => {
    expect(resolveBreakPoints(40 * oneMin, config({}), undefined)).toBeNull();
    expect(resolveBreakPoints(40 * oneMin, config({}), [])).toBeNull();
  });

  test('uses the fallback rule when the program has no chapters', () => {
    const withFallback = config({
      breakRule: {
        type: 'chapters',
        chapterTypes: ['chapter'],
        fallback: { type: 'fixed_interval', intervalMs: 15 * oneMin },
      },
    });
    expect(
      offsetsMin(resolveBreakPoints(40 * oneMin, withFallback, [])),
    ).toEqual([15, 30]);
  });

  test('uses the fallback rule when no chapters match the selected types', () => {
    const withFallback = config({
      breakRule: {
        type: 'chapters',
        chapterTypes: ['chapter'],
        fallback: { type: 'percentage', points: [50] },
      },
    });
    expect(
      offsetsMin(
        resolveBreakPoints(40 * oneMin, withFallback, [chapter(1, 2, 'intro')]),
      ),
    ).toEqual([20]);
  });

  test('rounds fractional chapter times and drops duplicates', () => {
    const chapters: ChapterInfo[] = [
      { startTime: 0, endTime: 600_000.4, chapterType: 'chapter' },
      { startTime: 600_000.4, endTime: 1_200_000, chapterType: 'chapter' },
      { startTime: 0, endTime: 600_000, chapterType: 'intro' },
      { startTime: 1_200_000, endTime: 2_400_000, chapterType: 'chapter' },
    ];
    expect(
      resolveBreakPoints(
        40 * oneMin,
        config({
          breakRule: { type: 'chapters', chapterTypes: ['chapter', 'intro'] },
        }),
        chapters,
      ),
    ).toEqual([{ offsetMs: 600_000 }, { offsetMs: 1_200_000 }]);
  });

  test('drops chapter ends past the program duration', () => {
    expect(
      offsetsMin(resolveBreakPoints(25 * oneMin, config({}), fourActs)),
    ).toEqual([10, 20]);
  });

  test('applies the tail buffer and max breaks', () => {
    expect(
      offsetsMin(
        resolveBreakPoints(
          40 * oneMin,
          config({ tailBufferMs: 15 * oneMin }),
          fourActs,
        ),
      ),
    ).toEqual([10, 20]);
    expect(
      offsetsMin(
        resolveBreakPoints(40 * oneMin, config({ maxBreaks: 1 }), fourActs),
      ),
    ).toEqual([10]);
  });
});

describe('minBreakIntervalMs', () => {
  test('thins out dense chapters', () => {
    const dense = Array.from({ length: 10 }, (_, i) =>
      chapter(i * 4, (i + 1) * 4),
    );
    expect(
      offsetsMin(
        resolveBreakPoints(
          40 * oneMin,
          config({ minBreakIntervalMs: 10 * oneMin }),
          dense,
        ),
      ),
    ).toEqual([12, 24, 36]);
  });

  test('applies to the other rules too', () => {
    expect(
      offsetsMin(
        resolveBreakPoints(
          40 * oneMin,
          config({
            breakRule: { type: 'percentage', points: [10, 20, 60] },
            minBreakIntervalMs: 6 * oneMin,
          }),
        ),
      ),
    ).toEqual([8, 24]);
  });

  test('applies before max breaks', () => {
    expect(
      offsetsMin(
        resolveBreakPoints(
          40 * oneMin,
          config({
            breakRule: { type: 'fixed_interval', intervalMs: 5 * oneMin },
            minBreakIntervalMs: 10 * oneMin,
            maxBreaks: 2,
          }),
        ),
      ),
    ).toEqual([10, 20]);
  });

  test('applyMinBreakInterval keeps everything when unset or zero', () => {
    expect(applyMinBreakInterval([1, 2, 3], undefined)).toEqual([1, 2, 3]);
    expect(applyMinBreakInterval([1, 2, 3], 0)).toEqual([1, 2, 3]);
  });
});

describe('chapterBreakOffsets', () => {
  test('returns an empty list, not null, when matching chapters give no boundaries', () => {
    expect(
      chapterBreakOffsets(40 * oneMin, ['chapter'], [chapter(0, 40)]),
    ).toEqual([]);
  });
});
