import { test, expect } from './fixtures'
import { a11yViolations } from './axe'
import type { Locator, Page } from '@playwright/test'

/**
 * Moving blocks in the calendar when the time is taken. The server refuses an overlapping booking (422); the calendar must put the block
 * back exactly where it was, say so in the same conflict dialog as the task pages, and change nothing on the server. A free time works, and
 * the position survives a reload. Day and week behave the same, in English and in Arabic (RTL), in light and dark.
 * Real Laravel server, throwaway database, isolated data: every event made here is removed at the end.
 */
const ZONE = 'Europe/Amsterdam'
test.use({ timezoneId: ZONE, viewport: { width: 1440, height: 900 } })

async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, path, body] as const)
}

/** The instant at which the wall clock in `ZONE` reads `day` `time` (two passes settle the offset). */
function instantAt(day: string, time: string): string {
  const [y, m, d] = day.split('-').map(Number), [h, mi] = time.split(':').map(Number)
  const wanted = Date.UTC(y, m - 1, d, h, mi)
  let guess = wanted
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(guess)).map(x => [x.type, Number(x.value)]))
    guess += wanted - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
  }
  return new Date(guess).toISOString()
}
/** A Saturday at least two weeks away (the demo account has nothing on Saturdays), as YYYY-MM-DD in the account's zone. */
function saturday(): string {
  for (let days = 14; ; days++) {
    const at = new Date(Date.now() + days * 86_400_000)
    if (new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'short' }).format(at) === 'Sat') return at.toLocaleDateString('en-CA', { timeZone: ZONE })
  }
}

type Made = { day: string; a: number; b: number; ids: number[] }
/** A: 10:00–11:00 and B: 12:00–13:00, both flexible blocks. */
async function seed(page: Page): Promise<Made> {
  await page.goto('/')
  const day = saturday(), ids: number[] = [], stamp = Date.now()
  for (const [title, from, to] of [[`Plan ${stamp}`, '10:00', '11:00'], [`Review ${stamp}`, '12:00', '13:00']] as const) {
    const made = await call(page, 'POST', '/api/events', { title, kind: 'flexible', starts_at: instantAt(day, from), ends_at: instantAt(day, to), timezone: ZONE })
    expect(made.status).toBe(201)
    ids.push((made.body as { data: { id: number } }).data.id)
  }
  return { day, a: ids[0], b: ids[1], ids }
}
async function cleanup(page: Page, made: Made) { await page.goto('/'); for (const id of made.ids) await call(page, 'DELETE', `/api/events/${id}`) }
async function openCalendar(page: Page, made: Made, view: 'day' | 'week') {
  await page.goto('/')
  await page.evaluate(v => localStorage.setItem('lifeos-calendar-view', v), view)
  await page.goto(`/calendar?date=${made.day}`)
  const block = page.locator(`[data-session="${made.a}"]`)
  await expect(block).toBeVisible()
  // Measure only once the page has stopped moving (web fonts swapping in shift the header by a few pixels on a slow run).
  await page.evaluate(() => document.fonts.ready)
  let last = ''
  await expect.poll(async () => { const b = await block.boundingBox(), now = JSON.stringify(b); const same = now === last; last = now; return same }, { intervals: [150], timeout: 10_000 }).toBe(true)
}
const blockOf = (page: Page, id: number): Locator => page.locator(`.grid-event[data-session="${id}"]`)
/** What the server stores for an event right now. */
async function stored(page: Page, id: number) {
  const r = await call(page, 'GET', `/api/events/${id}`)
  const d = (r.body as { data: { starts_at: string; ends_at: string } }).data
  return `${new Date(d.starts_at).toISOString()}|${new Date(d.ends_at).toISOString()}`
}
/** Press on `from`, move by (0, dy) in a few steps, release. */
async function dragBy(page: Page, from: { x: number; y: number }, dy: number) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x, from.y + dy / 2, { steps: 4 })
  await page.mouse.move(from.x, from.y + dy, { steps: 4 })
  await page.mouse.up()
}
const HOUR = 52
async function centre(l: Locator) { const b = (await l.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b } }
async function bottomEdge(l: Locator) { const b = (await l.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height - 4, box: b } }

for (const view of ['day', 'week'] as const) {
  test(`${view} view: dragging onto a busy time is refused with the conflict dialog and the block returns; a free time works and survives a reload`, async ({ page, setLanguage, guard }) => {
    test.setTimeout(120_000)
    guard.allowConsole(/status of 42[29]/)
    await setLanguage('en')
    const made = await seed(page)
    try {
      await openCalendar(page, made, view)
      const a = blockOf(page, made.a), count = await page.locator('.grid-event').count()
      const before = (await a.boundingBox())!, beforeText = await a.innerText(), serverBefore = await stored(page, made.a)
      expect(before.height).toBeCloseTo(HOUR - 2, 0)                          // 60 minutes is 50px: the length of the block
      expect(beforeText).toContain('10:00 – 11:00')

      // 90 minutes down: 11:30 – 12:30 overlaps the 12:00 block.
      const refusedAnswer = page.waitForResponse(r => r.url().includes(`/api/events/${made.a}`) && r.request().method() === 'PATCH')
      // Late content above the grid can still shift it a few pixels after the page looks ready: the block must come back to where it was when the drag began.
      // (position inside the grid, not on screen: dragging near the edge may scroll the grid itself)
      const spot = () => a.evaluate(el => { const h = el as HTMLElement; return [Math.round(h.offsetTop), Math.round(h.offsetHeight)] })
      const start = await spot()
      await dragBy(page, await centre(a), 1.5 * HOUR)
      expect((await refusedAnswer).status()).toBe(422)
      const dialog = page.getByRole('alertdialog')
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText('Review')
      await expect(dialog).toContainText(/12:00/)
      // The block springs back (a short transform transition): it must end exactly where it started.
      await expect.poll(spot, { timeout: 5000 }).toEqual(start)
      expect(await a.innerText()).toBe(beforeText)
      expect(await stored(page, made.a)).toBe(serverBefore)
      expect(await page.locator('.grid-event').count()).toBe(count)
      await expect(page.getByText(/now 11:30/)).toHaveCount(0)

      // "Choose another time" puts focus back on the block that did not move.
      await dialog.getByRole('button', { name: 'Choose another time' }).click()
      await expect(dialog).toBeHidden()
      await expect(a).toBeFocused()

      // Resizing the end into the busy block is refused the same way.
      const resized = page.waitForResponse(r => r.url().includes(`/api/events/${made.a}`) && r.request().method() === 'PATCH')
      await dragBy(page, await bottomEdge(a), 1.5 * HOUR)
      expect((await resized).status()).toBe(422)
      await expect(page.getByRole('alertdialog')).toBeVisible()
      expect((await a.boundingBox())!.height).toBeCloseTo(before.height, 0)
      expect(await stored(page, made.a)).toBe(serverBefore)
      await page.getByRole('alertdialog').getByRole('button', { name: 'Close' }).click()
      await expect(page.getByRole('alertdialog')).toBeHidden()

      // A free time (11:00 – 12:00, touching the other block without overlapping it) is saved; nothing was added or removed.
      const saved = page.waitForResponse(r => r.url().includes(`/api/events/${made.a}`) && r.request().method() === 'PATCH')
      await dragBy(page, await centre(a), HOUR)
      expect((await saved).status()).toBe(200)
      await expect(a).toContainText('11:00 – 12:00')
      await expect(page.getByRole('alertdialog')).toHaveCount(0)
      expect(await page.locator('.grid-event').count()).toBe(count)
      const serverAfter = await stored(page, made.a)
      expect(serverAfter).toBe(`${instantAt(made.day, '11:00')}|${instantAt(made.day, '12:00')}`.replace(/\.\d+Z/g, '.000Z'))

      // After a reload it is where it was put.
      await page.reload()
      await expect(blockOf(page, made.a)).toContainText('11:00 – 12:00')
      expect(await page.locator('.grid-event').count()).toBe(count)
      expect(await stored(page, made.a)).toBe(serverAfter)
    } finally { await cleanup(page, made) }
  })
}

test('keyboard: Alt+Arrow into a busy time is refused with the dialog; Escape returns focus to the block', async ({ page, setLanguage, guard }) => {
  guard.allowConsole(/status of 42[29]/)
  await setLanguage('en')
  const made = await seed(page)
  try {
    await openCalendar(page, made, 'day')
    const a = blockOf(page, made.a), before = await stored(page, made.a)
    await a.focus()
    // 15 minutes each, one request at a time (a step pressed while one is still being saved is ignored): 11:00 – 12:00 is free, the 5th step is not.
    for (let i = 0; i < 4; i++) {
      const step = page.waitForResponse(r => r.url().includes(`/api/events/${made.a}`) && r.request().method() === 'PATCH' && r.status() === 200)
      await page.keyboard.press('Alt+ArrowDown'); await step
    }
    await expect(a).toContainText('11:00 – 12:00')
    const refused = page.waitForResponse(r => r.url().includes(`/api/events/${made.a}`) && r.request().method() === 'PATCH' && r.status() === 422)
    await page.keyboard.press('Alt+ArrowDown')
    await refused
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(a).toBeFocused()
    await expect(a).toContainText('11:00 – 12:00')                                       // the step that was refused is not drawn
    expect(await stored(page, made.a)).not.toBe(before)                                  // the four free steps were saved
  } finally { await cleanup(page, made) }
})

test('Arabic (RTL): the same refusal, in Arabic, with the time column on the right and Latin 24-hour times', async ({ page, setLanguage, guard }) => {
  test.setTimeout(90_000)
  guard.allowConsole(/status of 42[29]/)
  await setLanguage('ar')
  const made = await seed(page)
  try {
    await openCalendar(page, made, 'day')
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    const gutter = (await page.locator('.time-gutter').boundingBox())!, column = (await page.locator('.time-column').first().boundingBox())!
    expect(gutter.x).toBeGreaterThan(column.x)                                           // the hours are on the right-hand side
    const a = blockOf(page, made.a), before = (await a.boundingBox())!
    await expect(a).toContainText('10:00 – 11:00')
    await dragBy(page, await centre(a), 1.5 * HOUR)
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('محجوز')
    await expect(dialog).toContainText('12:00')
    expect((await a.boundingBox())!.y).toBeCloseTo(before.y, 0)
    await dialog.getByRole('button', { name: 'اختيار وقت آخر' }).click()
    await expect(a).toBeFocused()
  } finally { await cleanup(page, made); await setLanguage('en') }
})

for (const scheme of ['light', 'dark'] as const) {
  test(`${scheme} theme: the refusal dialog and the calendar have no accessibility violations`, async ({ page, setLanguage, guard }) => {
    test.setTimeout(90_000)
    guard.allowConsole(/status of 42[29]/)
    await setLanguage('en')
    await page.emulateMedia({ colorScheme: scheme })
    const made = await seed(page)
    try {
      await openCalendar(page, made, 'day')
      await expect(page.locator('.cal-legend')).toBeVisible()
      await dragBy(page, await centre(blockOf(page, made.a)), 1.5 * HOUR)
      const dialog = page.getByRole('alertdialog')
      await expect(dialog).toBeVisible()
      expect(await a11yViolations(page, '.sc-dialog')).toEqual([])
      await dialog.getByRole('button', { name: 'Close' }).click()
      await expect(dialog).toBeHidden()
      expect(await a11yViolations(page, '.time-grid')).toEqual([])
    } finally { await cleanup(page, made) }
  })
}
