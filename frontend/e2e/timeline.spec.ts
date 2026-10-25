import { test, expect } from './fixtures'
import type { TimelineData, TimelineItem } from '../src/lib/timeline'

test('day and week views, filters, and a move preview that never saves by itself', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/timeline')
  await expect(page.locator('.tl-item').first()).toBeVisible()
  await page.getByRole('radio', { name: 'Week' }).click()
  await expect(page.locator('.tl-day')).toHaveCount(7)
  await page.getByRole('radio', { name: 'Day' }).click()

  await page.getByRole('button', { name: /^Filters/ }).click()
  const lifeos = page.locator('.timeline-filters .filter-chip', { hasText: 'LifeOS' }).first()
  await lifeos.click()
  await expect(lifeos).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Clear filters' }).first().click()

  // Find a day with two timed LifeOS events: move the first onto the second and expect a clash.
  const day = await page.evaluate(async () => {
    for (let i = 0; i < 14; i++) {
      const d = new Date(Date.now() + i * 86400000).toLocaleDateString('en-CA')
      const data = await (await fetch(`/api/timeline?from=${d}`, { credentials: 'include', headers: { Accept: 'application/json' } })).json() as TimelineData
      const movable = data.items.filter((x: TimelineItem) => x.kind === 'event' && x.meta.event_id && !x.all_day && x.ends_at)
      if (movable.length >= 2) return { date: d, zone: data.range.timezone, a: movable[0], b: movable[1] }
    }
    return null
  })
  expect(day, 'demo data has a day with two LifeOS events').not.toBeNull()
  const local = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: day!.zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))
  const before = await page.evaluate(async id => (await (await fetch(`/api/timeline?from=${id}`, { credentials: 'include', headers: { Accept: 'application/json' } })).json()).items.length, day!.date)

  await page.fill('.date-nav input[type=date]', day!.date)
  await page.locator('.tl-item.kind-event', { hasText: day!.a.title }).first().getByRole('button', { name: 'Move' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('This time is free.')).toBeVisible()
  await dialog.getByLabel('Start').fill(local(day!.b.starts_at))
  await dialog.getByLabel('End').fill(local(day!.b.ends_at!))
  await expect(dialog.locator('.move-preview.has-clash')).toContainText(day!.b.title)
  await expect(dialog.getByRole('button', { name: 'Move', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  const after = await page.evaluate(async id => (await (await fetch(`/api/timeline?from=${id}`, { credentials: 'include', headers: { Accept: 'application/json' } })).json()).items.length, day!.date)
  expect(after).toBe(before)
})
