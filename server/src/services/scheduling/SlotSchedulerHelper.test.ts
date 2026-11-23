import type {
  MidRollConfig,
  RandomSlotSchedule,
  SlotFiller,
  TimeSlotSchedule,
} from '@tunarr/types/api';
import dayjs from 'dayjs';
import { randomUUID } from 'node:crypto';
import { anything, capture, instance, mock, when } from 'ts-mockito';
import { describe, expect, test } from 'vitest';
import type { CustomShowDB } from '../../db/CustomShowDB.ts';
import type { FillerDB } from '../../db/FillerListDB.ts';
import type { IChannelDB } from '../../db/interfaces/IChannelDB.ts';
import type { ProgramDB } from '../../db/ProgramDB.ts';
import type { ProgramWithRelationsOrm } from '../../db/schema/derivedTypes.ts';
import type { SmartCollectionsDB } from '../../db/SmartCollectionsDB.ts';
import { createFakeProgramOrm } from '../../testing/fakes/entityCreators.ts';
import type { ChapterInfo } from './midRollBreakRules.ts';
import { SlotSchedulerService } from './RandomSlotSchedulerService.ts';
import { SlotSchedulerHelper } from './SlotSchedulerHelper.ts';
import type { ChapterMap } from './slotSchedulerUtil.ts';
import { TimeSlotSchedulerService } from './TimeSlotSchedulerService.ts';

const oneMin = 60 * 1000;
const midnight = dayjs('2024-01-01T00:00:00.000Z');

const customShowId = randomUUID();
const fillerListId = randomUUID();

const movies: ProgramWithRelationsOrm[] = Array.from({ length: 2 }, (_, i) =>
  createFakeProgramOrm({
    uuid: `movie-${i}`,
    title: `Movie ${i}`,
    type: 'movie',
    duration: 25 * oneMin,
  }),
);

const ads: ProgramWithRelationsOrm[] = Array.from({ length: 20 }, (_, i) =>
  createFakeProgramOrm({
    uuid: `ad-${i}`,
    title: `Ad ${i}`,
    type: 'other_video',
    duration: 30 * 1000,
  }),
);

function chapter(startMin: number, endMin: number): ChapterInfo {
  return {
    startTime: startMin * oneMin,
    endTime: endMin * oneMin,
    chapterType: 'chapter',
  };
}

// Only the first movie has chapters.
const chapterMap: ChapterMap = new Map([
  ['movie-0', [chapter(0, 7), chapter(7, 16), chapter(16, 25)]],
]);

const filler: SlotFiller[] = [
  { types: ['mid'], fillerListId, fillerOrder: 'uniform' },
];

const midRoll: MidRollConfig = {
  strategy: 'eager',
  breakRule: { type: 'chapters', chapterTypes: ['chapter'] },
  breakDurationMs: oneMin,
  maxBreaks: 0,
  minProgramDurationMs: 0,
  tailBufferMs: 0,
};

const timeSchedule: TimeSlotSchedule = {
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

const randomSchedule: RandomSlotSchedule = {
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

function makeHelper() {
  const customShowDB = mock<CustomShowDB>();
  const fillerDB = mock<FillerDB>();
  const programDB = mock<ProgramDB>();

  when(customShowDB.getShowPrograms(customShowId)).thenResolve(movies);
  when(fillerDB.getFillerPrograms(fillerListId)).thenResolve(ads);
  when(programDB.getProgramsByIds(anything())).thenResolve([]);
  when(programDB.getChaptersByProgramIds(anything())).thenResolve(chapterMap);

  const helper = new SlotSchedulerHelper(
    instance(customShowDB),
    instance(fillerDB),
    instance(programDB),
    instance(mock<SmartCollectionsDB>()),
    instance(mock<IChannelDB>()),
  );
  return { helper, programDB };
}

type Item = { type: string; id?: string; startOffsetMs?: number };

// Where each piece of the first airing of a movie resumes, in minutes.
function firstRunOffsets(lineup: Item[], movieId: string): number[] {
  const start = lineup.findIndex((p) => p.id === movieId);
  const offsets: number[] = [];
  for (const item of lineup.slice(start)) {
    if (item.type === 'custom' && item.id !== movieId) break;
    if (item.id === movieId) {
      if (offsets.length > 0 && (item.startOffsetMs ?? 0) === 0) break;
      offsets.push((item.startOffsetMs ?? 0) / oneMin);
    }
  }
  return offsets;
}

describe('SlotSchedulerHelper.collectSlotProgramming', () => {
  test('loads chapters for every program it collects', async () => {
    const { helper, programDB } = makeHelper();

    const result = await helper.collectSlotProgramming({
      type: 'programs',
      programIds: [],
      schedule: timeSchedule,
    });

    expect(result.chapterMap).toBe(chapterMap);
    const [requestedIds] = capture(programDB.getChaptersByProgramIds).last();
    expect([...requestedIds].sort()).toEqual(
      [...movies, ...ads].map((p) => p.uuid).sort(),
    );
  });
});

describe('slot scheduler services', () => {
  test('time slots split programs at the chapters the helper loaded', async () => {
    const { helper } = makeHelper();

    const result = await new TimeSlotSchedulerService(helper).schedule({
      type: 'programs',
      programIds: [],
      schedule: timeSchedule,
      seed: [42, 99],
      startTime: +midnight,
    });

    expect(firstRunOffsets(result.lineup, 'movie-0')).toEqual([0, 7, 16]);
    // No chapters and no fallback: the program plays unbroken.
    expect(firstRunOffsets(result.lineup, 'movie-1')).toEqual([0]);
  });

  test('random slots split programs at the chapters the helper loaded', async () => {
    const { helper } = makeHelper();

    const result = await new SlotSchedulerService(helper).schedule({
      type: 'programs',
      programIds: [],
      schedule: randomSchedule,
      seed: [42, 99],
      startTime: +midnight,
    });

    expect(firstRunOffsets(result.lineup, 'movie-0')).toEqual([0, 7, 16]);
    expect(firstRunOffsets(result.lineup, 'movie-1')).toEqual([0]);
  });
});
