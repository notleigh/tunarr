import { faker } from '@faker-js/faker';
import tmp from 'tmp-promise';
import { v4 } from 'uuid';
import { test as baseTest, describe, expect } from 'vitest';
import { bootstrapTunarr } from '../../bootstrap.ts';
import { setGlobalOptions } from '../../globals.ts';
import { copyPreMigratedDb } from '../../testing/testDbFactory.ts';
import { DBAccess } from '../DBAccess.ts';
import type { DrizzleDBAccess } from '../schema/index.ts';
import { Program } from '../schema/Program.ts';
import type { ProgramChapterType } from '../schema/ProgramChapter.ts';
import { ProgramChapter } from '../schema/ProgramChapter.ts';
import { ProgramVersion } from '../schema/ProgramVersion.ts';
import { BasicProgramRepository } from './BasicProgramRepository.ts';

type Fixture = {
  db: string;
  drizzle: DrizzleDBAccess;
  repo: BasicProgramRepository;
};

const test = baseTest.extend<Fixture>({
  db: async ({}, use) => {
    const dbResult = await tmp.dir({ unsafeCleanup: true });
    await copyPreMigratedDb(dbResult.path);
    setGlobalOptions({
      database: dbResult.path,
      log_level: 'debug',
      verbose: 0,
    });
    await bootstrapTunarr();
    await use(dbResult.path);
    await dbResult.cleanup();
  },
  drizzle: async ({ db: _ }, use) => {
    const drizzle = DBAccess.instance.drizzle;
    if (!drizzle) {
      throw new Error('Drizzle is not initialized');
    }

    // DBAccess is a process-wide singleton, so rows survive between tests.
    await drizzle.delete(Program);
    await use(drizzle);
  },
  repo: async ({ drizzle }, use) => {
    const kysely = DBAccess.instance.db;
    if (!kysely) {
      throw new Error('Kysely is not initialized');
    }
    await use(new BasicProgramRepository(kysely, drizzle));
  },
});

async function insertProgram(drizzle: DrizzleDBAccess): Promise<string> {
  const uuid = v4();
  await drizzle.insert(Program).values({
    uuid,
    duration: 40 * 60_000,
    type: 'movie',
    sourceType: 'local',
    externalKey: faker.string.alphanumeric(16),
    externalSourceId: faker.string.alphanumeric(16),
    title: faker.word.words(3),
  });
  return uuid;
}

async function insertVersionWithChapters(
  drizzle: DrizzleDBAccess,
  programId: string,
  chapters: [number, number, ProgramChapterType][],
): Promise<void> {
  const versionId = v4();
  await drizzle.insert(ProgramVersion).values({
    uuid: versionId,
    createdAt: new Date(),
    updatedAt: new Date(),
    duration: 40 * 60_000,
    scanKind: 'progressive',
    width: 1920,
    height: 1080,
    programId,
  });
  if (chapters.length === 0) {
    return;
  }
  await drizzle.insert(ProgramChapter).values(
    chapters.map(([startTime, endTime, chapterType], index) => ({
      uuid: v4(),
      index,
      startTime,
      endTime,
      chapterType,
      programVersionId: versionId,
    })),
  );
}

describe('BasicProgramRepository.getChaptersByProgramIds', () => {
  test('groups chapters by program in index order', async ({
    drizzle,
    repo,
  }) => {
    const withChapters = await insertProgram(drizzle);
    const withoutChapters = await insertProgram(drizzle);
    const notRequested = await insertProgram(drizzle);

    // Inserted in index order; the ORDER BY must keep it regardless of times.
    await insertVersionWithChapters(drizzle, withChapters, [
      [0, 600_000, 'chapter'],
      [30_000, 90_000, 'intro'],
      [600_000, 2_400_000, 'chapter'],
    ]);
    await insertVersionWithChapters(drizzle, withoutChapters, []);
    await insertVersionWithChapters(drizzle, notRequested, [
      [0, 1_000, 'chapter'],
    ]);

    const result = await repo.getChaptersByProgramIds(
      [withChapters, withoutChapters],
      // Exercise batching.
      1,
    );

    expect([...result.keys()]).toEqual([withChapters]);
    expect(result.get(withChapters)).toEqual([
      { startTime: 0, endTime: 600_000, chapterType: 'chapter' },
      { startTime: 30_000, endTime: 90_000, chapterType: 'intro' },
      { startTime: 600_000, endTime: 2_400_000, chapterType: 'chapter' },
    ]);
  });

  test('returns an empty map for no IDs', async ({ repo }) => {
    expect((await repo.getChaptersByProgramIds([])).size).toBe(0);
  });
});
