import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MEDIA_DIR } from './env.ts';

type Clip = {
  file: string;
  seconds: number;
  pattern: 'testsrc2' | 'smptebars' | 'rgbtestsrc';
  // Chapter boundaries in seconds. The clip gets a chapter between each
  // consecutive pair of 0, these, and its length.
  chapterBoundaries?: number[];
};

export const MOVIES_DIR = path.join(MEDIA_DIR, 'movies');
export const SHOWS_DIR = path.join(MEDIA_DIR, 'shows');
export const FILLER_DIR = path.join(MEDIA_DIR, 'filler');

const SHOW = 'Test Pattern Theater (2021)';

// Paths follow the Jellyfin-style naming the local scanners parse.
const CLIPS: Clip[] = [
  {
    file: 'movies/Color Bars (2019)/Color Bars (2019).mkv',
    seconds: 180,
    pattern: 'smptebars',
    // Three one-minute chapters, for chapter-based mid-roll breaks.
    chapterBoundaries: [60, 120],
  },
  {
    file: 'movies/Moving Gradient (2020)/Moving Gradient (2020).mkv',
    seconds: 150,
    pattern: 'testsrc2',
  },
  {
    file: 'movies/Primary Colors (2022)/Primary Colors (2022).mkv',
    seconds: 120,
    pattern: 'rgbtestsrc',
  },
  ...[1, 2].flatMap((season) =>
    [1, 2, 3].map(
      (episode): Clip => ({
        file: `shows/${SHOW}/Season 0${season}/${SHOW} - S0${season}E0${episode}.mkv`,
        seconds: 60,
        pattern: 'testsrc2',
      }),
    ),
  ),
  { file: 'filler/Bumper One.mkv', seconds: 10, pattern: 'smptebars' },
  { file: 'filler/Bumper Two.mkv', seconds: 15, pattern: 'rgbtestsrc' },
];

// Bump when CLIPS changes so cached media is regenerated.
const MEDIA_VERSION = '2';
const MARKER = path.join(MEDIA_DIR, '.version');

// An FFMETADATA file describing the clip's chapters.
function chapterMetadata(clip: Clip, boundaries: number[]): string {
  const edges = [0, ...boundaries, clip.seconds];
  const chapters = edges
    .slice(0, -1)
    .map((start, i) =>
      [
        '[CHAPTER]',
        'TIMEBASE=1/1000',
        `START=${start * 1000}`,
        `END=${(edges[i + 1] ?? clip.seconds) * 1000}`,
        `title=Chapter ${i + 1}`,
      ].join('\n'),
    );
  return [';FFMETADATA1', ...chapters, ''].join('\n');
}

export function ensureMedia() {
  if (existsSync(MARKER) && readFileSync(MARKER, 'utf8') === MEDIA_VERSION) {
    return;
  }

  for (const clip of CLIPS) {
    const out = path.join(MEDIA_DIR, clip.file);
    mkdirSync(path.dirname(out), { recursive: true });
    const chapterArgs: string[] = [];
    if (clip.chapterBoundaries) {
      // Outside the scanned folders, so no library picks it up.
      const metadataFile = path.join(
        MEDIA_DIR,
        `${path.basename(out)}.ffmetadata`,
      );
      writeFileSync(
        metadataFile,
        chapterMetadata(clip, clip.chapterBoundaries),
      );
      chapterArgs.push('-i', metadataFile, '-map_chapters', '2');
    }
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `${clip.pattern}=size=320x240:rate=24`,
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        ...chapterArgs,
        '-t',
        String(clip.seconds),
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        out,
      ],
      { stdio: 'inherit' },
    );
  }

  writeFileSync(MARKER, MEDIA_VERSION);
}
