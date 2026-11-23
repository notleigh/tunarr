import type {
  MidRollConfig,
  RandomSlotSchedule,
  SlotFiller,
  TimeSlotSchedule,
} from '@tunarr/types/api';
import dayjs from 'dayjs';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { createFakeProgramOrm } from '../../testing/fakes/entityCreators.ts';
import { RandomSlotScheduler } from './RandomSlotsService.ts';
import type { ChapterInfo } from './midRollBreakRules.ts';
import type { ChapterMap, SlotSchedulerProgram } from './slotSchedulerUtil.ts';
import { scheduleTimeSlots } from './TimeSlotService.ts';

const oneMin = 60 * 1000;
const midnight = dayjs('2024-01-01T00:00:00.000Z');

const customShowId = randomUUID();
const fillerListId = randomUUID();

// A playlist of movies, the way users schedule movies with mid-roll breaks.
const movies: SlotSchedulerProgram[] = Array.from({ length: 3 }, (_, i) => ({
  ...createFakeProgramOrm({
    uuid: `movie-${i}`,
    title: `Movie ${i}`,
    type: 'movie',
    duration: 25 * oneMin,
  }),
  parentFillerLists: [],
  parentCustomShows: [{ customShowId, index: i }],
  parentSmartCollections: [],
}));

const commercials: SlotSchedulerProgram[] = Array.from(
  { length: 20 },
  (_, i) => ({
    ...createFakeProgramOrm({
      uuid: `ad-${i}`,
      title: `Ad ${i}`,
      type: 'other_video',
      duration: 30 * 1000,
    }),
    parentFillerLists: [fillerListId],
    parentCustomShows: [],
    parentSmartCollections: [],
  }),
);

const filler: SlotFiller[] = [
  { types: ['mid'], fillerListId, fillerOrder: 'uniform' },
];

// Breaks at chapter ends. Programs without chapters fall back to one break
// 10 minutes in and one 20 minutes in.
const midRoll: MidRollConfig = {
  strategy: 'eager',
  breakRule: {
    type: 'chapters',
    chapterTypes: ['chapter'],
    fallback: { type: 'fixed_interval', intervalMs: 10 * oneMin },
  },
  breakDurationMs: oneMin,
  maxBreaks: 0,
  minProgramDurationMs: 0,
  tailBufferMs: 0,
};

function chapter(startMin: number, endMin: number): ChapterInfo {
  return {
    startTime: startMin * oneMin,
    endTime: endMin * oneMin,
    chapterType: 'chapter',
  };
}

// Only the first movie has chapters: acts end at 7 and 16 minutes.
const chapterMap: ChapterMap = new Map([
  ['movie-0', [chapter(0, 7), chapter(7, 16), chapter(16, 25)]],
]);

type Item = {
  type: string;
  id?: string;
  duration: number;
  startOffsetMs?: number;
  fillerType?: string;
};

// The first airing of the first movie, from its first segment through its
// last. The playlist repeats over the day, so stop at the next program.
function firstRun(lineup: Item[], movieId: string) {
  const start = lineup.findIndex((p) => p.id === movieId);
  let end = start;
  for (let i = start + 1; i < lineup.length; i++) {
    const item = lineup[i];
    if (item === undefined || item.type === 'custom') {
      if (item?.id !== movieId) {
        break;
      }
    }
    if (item?.id === movieId) {
      end = i;
    }
  }
  return lineup.slice(start, end + 1);
}

function segmentsOf(lineup: Item[], movieId: string) {
  const segments = firstRun(lineup, movieId).filter((p) => p.id === movieId);
  return {
    offsets: segments.map((p) => (p.startOffsetMs ?? 0) / oneMin),
    durations: segments.map((p) => p.duration / oneMin),
  };
}

function expectChapterBreaks(lineup: Item[]) {
  // Split at the chapter ends.
  expect(segmentsOf(lineup, 'movie-0')).toEqual({
    offsets: [0, 7, 16],
    durations: [7, 9, 9],
  });
  // No chapters, so the fallback rule applies.
  expect(segmentsOf(lineup, 'movie-1')).toEqual({
    offsets: [0, 10, 20],
    durations: [10, 10, 5],
  });
}

describe('chapter-based mid-roll breaks', () => {
  test('time slots split programs at their chapter ends', async () => {
    const schedule: TimeSlotSchedule = {
      type: 'time',
      period: 'day',
      maxDays: 1,
      flexPreference: 'end',
      padMs: 30 * oneMin,
      latenessMs: 0,
      overflow: { type: 'duration', maxMs: 0 },
      timeZoneOffset: 0,
      slots: [
        {
          id: randomUUID(),
          startTime: 0,
          type: 'custom-show',
          customShowId,
          order: 'next',
          direction: 'asc',
          filler,
          midRoll,
        },
      ],
    };

    const result = await scheduleTimeSlots(
      schedule,
      [...movies, ...commercials],
      [42, 99],
      undefined,
      midnight,
      {},
      chapterMap,
    );

    expectChapterBreaks(result.lineup as Item[]);
  });

  test('random slots split programs at their chapter ends', () => {
    const schedule: RandomSlotSchedule = {
      type: 'random',
      flexPreference: 'end',
      maxDays: 1,
      padMs: 1,
      padStyle: 'episode',
      randomDistribution: 'uniform',
      lockWeights: false,
      slots: [
        {
          weight: 100,
          cooldownMs: 0,
          durationSpec: { type: 'dynamic', programCount: 1 },
          type: 'custom-show',
          customShowId,
          order: 'next',
          direction: 'asc',
          filler,
          midRoll,
        },
      ],
    };

    const result = new RandomSlotScheduler(schedule).generateSchedule(
      [...movies, ...commercials],
      [42, 99],
      0,
      midnight,
      {},
      chapterMap,
    );

    expectChapterBreaks(result.lineup as Item[]);
  });
});
