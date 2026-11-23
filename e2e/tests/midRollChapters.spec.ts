import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { readFixtureIds } from './routes.ts';

// The fixture's Color Bars movie is 3 minutes long with chapters ending at
// 1:00, 2:00 and 3:00. A Chapter Markers rule should split it at 1:00 and
// 2:00. This drives the whole path: ffprobe scan, slot editor, scheduler,
// and the preview. The preview is never saved, so the channel is untouched.

const channelId = () => {
  const id = readFixtureIds().channelIds[1];
  if (id === undefined) {
    throw new Error('Fixture needs at least 2 channels');
  }
  return id;
};

// MUI selects whose label is not linked to them have no accessible name, so
// find them by their visible value.
const selectShowing = (scope: Locator, value: string) =>
  scope.getByRole('combobox').filter({ hasText: new RegExp(`^${value}$`) });

async function chooseOption(page: Page, combobox: Locator, option: string) {
  await combobox.click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

// A day is plenty, and keeps the preview quick.
async function refreshPreview(page: Page) {
  await page.getByRole('textbox', { name: 'Days to Precalculate' }).fill('1');
  const refresh = page.getByRole('button', { name: 'Refresh Preview' });
  await refresh.click();
  await expect(refresh).toBeEnabled({ timeout: 30_000 });
}

// Each airing of the 3-minute movie is grouped with its two 1-minute breaks:
// 5 minutes in all.
async function expectChapterBreaks(page: Page) {
  const firstAiring = page
    .getByText('E2E Chaptered - 000 - Color Bars - (05 mins)')
    .first();
  await expect(firstAiring).toBeVisible();
  await expect(page.getByText('2 breaks').first()).toBeVisible();
  await expect(page.getByText('1 break', { exact: true })).toHaveCount(0);
}

async function addChapteredSlot(
  page: Page,
  fallback: 'None' | 'Fixed Interval',
) {
  await page.getByRole('button', { name: 'Add Slot' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Slot' });

  // One program per slot, from the playlist that holds the chaptered movie.
  await dialog.getByRole('button', { name: 'Dynamic' }).click();
  await chooseOption(page, selectShowing(dialog, 'Show'), 'Playlist');
  await chooseOption(
    page,
    dialog.getByRole('combobox', { name: 'Playlist' }),
    'E2E Chaptered',
  );

  // Mid-roll appears once a filler list plays as Mid filler.
  await dialog.getByRole('tab', { name: 'Filler' }).click();
  await dialog.getByRole('button', { name: 'Add filler' }).click();
  await dialog.getByRole('button', { name: 'Pre', exact: true }).click();
  await dialog.getByRole('button', { name: 'Mid', exact: true }).click();
  await dialog.getByRole('tab', { name: 'Mid-Roll' }).click();

  await chooseOption(
    page,
    dialog.getByRole('combobox', { name: 'Break Rule' }),
    'Chapter Markers',
  );
  await expect(
    dialog.getByRole('checkbox', { name: 'Chapters' }),
  ).toBeChecked();
  const fallbackRule = dialog.getByRole('combobox', { name: 'Fallback Rule' });
  await expect(fallbackRule).toHaveText('None');
  if (fallback !== 'None') {
    await chooseOption(page, fallbackRule, fallback);
    // The fallback's own settings appear inline.
    await expect(
      dialog.getByRole('spinbutton', { name: 'Break Interval (minutes)' }),
    ).toBeVisible();
  }

  // The movie is shorter than the default minimum, and a 3-minute break
  // would not fit before its end.
  await dialog
    .getByRole('spinbutton', { name: 'Break Duration (minutes)' })
    .fill('1');
  await dialog
    .getByRole('spinbutton', { name: 'Minimum Program Duration (minutes)' })
    .fill('0');

  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
}

test('a Chapter Markers rule breaks the program at its chapters', async ({
  page,
}) => {
  await page.goto(`/web/channels/${channelId()}/programming/slot-editor`);
  await addChapteredSlot(page, 'None');

  await refreshPreview(page);

  await expectChapterBreaks(page);
});

test('switching to Chapter Markers keeps the fallback rule editable', async ({
  page,
}) => {
  await page.goto(`/web/channels/${channelId()}/programming/slot-editor`);
  await addChapteredSlot(page, 'Fixed Interval');

  // The chapters still win for a program that has them.
  await refreshPreview(page);
  await expectChapterBreaks(page);
});
