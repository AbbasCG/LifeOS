import { test, expect, field, pick } from './fixtures'
import { a11yViolations } from './axe'
import type { Page } from '@playwright/test'

/**
 * The task edit dialog: the "When" tiles move the day and keep the time, the selected tile is read from the saved deadline, and a task's
 * calendar session (a different record from its deadline) is shown and moved from the dialog. Real Laravel server, throwaway database;
 * every task and session made here is removed at the end. Desktop runs light, the mobile project runs dark.
 */
test.use({ timezoneId: 'UTC' })

type Reply = { status: number; body: { code?: string; timezone?: string; data?: unknown } }
async function call(page: Page, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return page.evaluate(async ([m, p, b, h]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token, ...(h as Record<string, string>) }, body: b ? JSON.stringify(b) : undefined })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, path, body, headers] as const)
}
type Occurrence = { event_id: number | null; task_id: number | null; starts_at: string; ends_at: string }
async function sessionsOf(page: Page, taskId: number) {
  const from = new Date(Date.now() - 86_400_000).toISOString(), to = new Date(Date.now() + 40 * 86_400_000).toISOString()
  const r = await call(page, 'GET', `/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
  expect(r.status).toBe(200)
  return (r.body.data as unknown as Occurrence[]).filter(o => o.task_id === taskId)
}
/** Day ('YYYY-MM-DD') and wall time ('HH:mm') of an instant in a timezone. The deadline and session fields are on this same account clock; the browser here is in UTC, to prove it. */
const wall = (at: Date | string, zone: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(at)).map(x => [x.type, x.value]))
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }
}
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/**
 * A 30-minute slot at 10:00 UTC on the first day, from about three days ahead, with nothing in the calendar between 06:00 and 14:00 UTC. The demo data
 * has events and weekly series, so a fixed "in three days at 10:00" collides with one of them on some weekdays and the booking is (rightly) refused.
 */
async function freeSlot(page: Page) {
  for (let i = 3; i < 43; i++) {
    const day = new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10)
    const r = await call(page, 'GET', `/api/calendar?from=${encodeURIComponent(`${day}T06:00:00Z`)}&to=${encodeURIComponent(`${day}T14:00:00Z`)}`)
    if (r.status === 200 && (r.body.data as unknown[]).length === 0) return { starts_at: `${day}T10:00:00.000Z`, ends_at: `${day}T10:30:00.000Z` }
  }
  throw new Error('no free day found')
}

async function makeTask(page: Page, label: string, due: (zone: string, today: string) => string | null) {
  await page.goto('/')
  const zone = (await call(page, 'GET', '/api/settings')).body.timezone as string
  const title = `E2E when ${label} ${Date.now()}`
  const made = await call(page, 'POST', '/api/tasks', { title, status: 'todo', priority: 'medium', estimated_minutes: 30, due_at: due(zone, wall(new Date(), zone).day) })
  expect(made.status).toBe(201)
  return { id: (made.body.data as { id: number }).id, title, zone }
}
async function cleanup(page: Page, taskId: number) {
  for (const s of await sessionsOf(page, taskId)) if (s.event_id) await call(page, 'DELETE', `/api/events/${s.event_id}`)
  await call(page, 'DELETE', `/api/tasks/${taskId}`)
}
async function openDialog(page: Page, title: string) {
  await page.goto('/tasks')
  const row = page.locator('.task-item', { hasText: title })
  if ((await row.locator('.task-body').getAttribute('aria-expanded')) !== 'true') await row.locator('.task-body').click()
  await row.getByRole('button', { name: /^Edit|^تعديل/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}
const deadlineValue = (dialog: ReturnType<Page['locator']>) => dialog.locator('.rf-deadline .dtp-trigger').getAttribute('data-value')
const checkedWhen = (dialog: ReturnType<Page['locator']>) => dialog.getByRole('radiogroup', { name: 'When' }).getByRole('radio', { checked: true })

test('Today and Tomorrow keep the time, the saved day selects its tile after reopening', async ({ page, setLanguage }) => {
  await setLanguage('en')
  // Due in 5 days at a time that is neither 17:00 nor 23:00, so a replaced time would show.
  const { id, title, zone } = await makeTask(page, 'time', (_z, today) => `${shift(today, 5)}T12:00:00.000Z`)
  try {
    const dialog = await openDialog(page, title)
    const before = (await deadlineValue(dialog))!
    const time = before.slice(11)
    expect(time).not.toBe('23:00')
    // The field is the account's clock, not this UTC browser's: 12:00Z reads as that zone's wall time, the same as the list badge.
    const dueWall = wall(`${shift(wall(new Date(), zone).day, 5)}T12:00:00.000Z`, zone)
    expect(before).toBe(`${dueWall.day}T${dueWall.time}`)
    const { day: today } = wall(new Date(), zone)
    await expect(checkedWhen(dialog)).toHaveCount(0)                        // five days away: no tile claims it
    await expect(dialog.locator('.rf-custom')).toContainText('Custom due date')

    await dialog.getByRole('radio', { name: 'Today' }).click()
    expect(await deadlineValue(dialog)).toBe(`${today}T${time}`)             // the day moved, the time did not
    await expect(checkedWhen(dialog)).toHaveText('Today')
    await expect(dialog.locator('.rf-custom')).toHaveText('')

    await dialog.getByRole('radio', { name: 'Tomorrow' }).click()
    expect(await deadlineValue(dialog)).toBe(`${shift(today, 1)}T${time}`)
    await expect(checkedWhen(dialog)).toHaveText('Tomorrow')

    const saved = page.waitForResponse(r => /\/api\/tasks\/\d+$/.test(r.url()) && r.request().method() === 'PATCH')
    await dialog.getByRole('button', { name: 'Save' }).click()
    expect((await saved).status()).toBe(200)
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Reopen: the tile comes from the saved deadline.
    const again = await openDialog(page, title)
    expect(await deadlineValue(again)).toBe(`${shift(today, 1)}T${time}`)
    await expect(checkedWhen(again)).toHaveText('Tomorrow')
    await again.getByRole('radio', { name: 'No date' }).click()
    expect(await deadlineValue(again)).toBe('')
    await expect(checkedWhen(again)).toHaveText('No date')
  } finally { await cleanup(page, id) }
})

test('a task due next Wednesday opens with no tile selected and a custom-date line', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const { id, title } = await makeTask(page, 'custom', (_z, today) => {
    let day = shift(today, 3)   // not today, tomorrow, or (being at least three days out) the coming Sunday unless it is one
    while (new Date(`${day}T12:00:00Z`).getUTCDay() !== 3) day = shift(day, 1)
    return `${day}T12:00:00.000Z`
  })
  try {
    const dialog = await openDialog(page, title)
    await expect(checkedWhen(dialog)).toHaveCount(0)
    await expect(dialog.locator('.rf-custom')).toContainText(/Custom due date: Wednesday/)
  } finally { await cleanup(page, id) }
})

test('moving the session from the dialog changes the calendar once and keeps the number of events', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const { id, title, zone } = await makeTask(page, 'session', () => new Date(Date.now() + 12 * 86_400_000).toISOString())
  try {
    const slot = await freeSlot(page)
    const booked = await call(page, 'POST', `/api/tasks/${id}/schedule`, slot, { 'Idempotency-Key': crypto.randomUUID() })
    expect(booked.status).toBe(201)
    const eventId = (booked.body.data as { id: number }).id
    const dialog = await openDialog(page, title)
    const block = dialog.getByRole('region', { name: 'Scheduled execution time' })
    await expect(block).toBeVisible()
    await expect(block).toContainText(wall(slot.starts_at, zone).time.replace(/^0/, ''))   // the session's own time, apart from the deadline
    await expect(block.getByText(/does not move the session/)).toBeVisible()

    // The new start is saved by the dialog's own Save: ONE PUT on the same session, then the task fields.
    const put: string[] = []
    page.on('request', r => { if (r.method() === 'PUT' && /\/api\/tasks\/\d+\/schedule$/.test(r.url())) put.push(r.postData() ?? '') })
    await pick(page, field(block, 'Execution start'), `${wall(slot.starts_at, zone).day}T11:30`)
    const moved = page.waitForResponse(r => /\/api\/tasks\/\d+\/schedule$/.test(r.url()) && r.request().method() === 'PUT')
    await dialog.getByRole('button', { name: 'Save' }).dblclick()
    expect((await moved).status()).toBe(200)
    await expect(dialog).toBeHidden()
    expect(put).toHaveLength(1)
    const again = (await openDialog(page, title)).getByRole('region', { name: 'Scheduled execution time' })   // after a reload it still shows the new time

    const after = await sessionsOf(page, id)
    expect(after).toHaveLength(1)
    expect(after[0].event_id).toBe(eventId)
    expect(after[0].starts_at).not.toBe(slot.starts_at)

    // "View in calendar" now points at the new day, and the session is drawn there once, at its new time.
    await again.getByRole('link', { name: 'View in calendar' }).click()
    await expect(page).toHaveURL(new RegExp(`/calendar\\?date=${wall(after[0].starts_at, zone).day}&session=${eventId}`))
    const drawn = page.locator(`[data-session="${eventId}"]`)
    await expect(drawn).toHaveCount(1)
    const { time } = wall(after[0].starts_at, zone), [hh, mm] = time.split(':'), h12 = String(Number(hh) % 12 || 12)
    await expect(drawn).toContainText(new RegExp(`(${hh}:${mm}|${h12}:${mm})`))
    await expect(page.locator('[data-session]', { hasText: title })).toHaveCount(1)
  } finally { await cleanup(page, id) }
})

test('the dialog reads right in Arabic (right to left) with the deadline and the session apart', async ({ page, setLanguage }) => {
  await setLanguage('ar')
  const { id, title } = await makeTask(page, 'rtl', () => new Date(Date.now() + 12 * 86_400_000).toISOString())
  try {
    const slot = await freeSlot(page)
    expect((await call(page, 'POST', `/api/tasks/${id}/schedule`, slot, { 'Idempotency-Key': crypto.randomUUID() })).status).toBe(201)
    await page.goto('/tasks')
    const row = page.locator('.task-item', { hasText: title })
    await row.locator('.task-body').click()
    await row.getByRole('button', { name: 'تعديل' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('الموعد النهائي (الاستحقاق)')).toBeVisible()
    await expect(dialog.getByRole('region', { name: 'موعد التنفيذ المجدول' })).toBeVisible()
    await expect(dialog.getByRole('link', { name: 'عرض في التقويم' })).toBeVisible()
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).direction)).toBe('rtl')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    expect(await a11yViolations(page, 'dialog.sheet')).toEqual([])
  } finally { await cleanup(page, id) }
})
