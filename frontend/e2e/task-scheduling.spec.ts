import { test, expect } from './fixtures'
import { a11yViolations } from './axe'
import type { Page } from '@playwright/test'

/**
 * A task is booked in the calendar once, however many times the user taps (the bug: the same task was booked on 11 and 12 Nov).
 * Real Laravel server, throwaway database, isolated e2e data only: every task and session made here is removed at the end.
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
const clock = (at: string, zone: string) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone })

/** The sessions of one task in the next two months, straight from the calendar API (what the calendar page draws). */
async function sessionsOf(page: Page, taskId: number) {
  const from = new Date(Date.now() - 86_400_000).toISOString(), to = new Date(Date.now() + 40 * 86_400_000).toISOString()
  const r = await call(page, 'GET', `/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
  expect(r.status).toBe(200)
  return (r.body.data as unknown as { event_id: number | null; task_id: number | null; starts_at: string; ends_at: string }[]).filter(o => o.task_id === taskId)
}

async function makeTask(page: Page, label: string, name?: string) {
  await page.goto('/')
  const zone = (await call(page, 'GET', '/api/settings')).body.timezone as string
  const title = name ?? `E2E sched ${label} ${Date.now()}`
  const made = await call(page, 'POST', '/api/tasks', { title, status: 'todo', priority: 'medium', estimated_minutes: 30, due_at: new Date(Date.now() + 5 * 86_400_000).toISOString() })
  expect(made.status).toBe(201)
  return { id: (made.body.data as { id: number }).id, title, zone }
}
async function cleanup(page: Page, taskId: number) {
  for (const s of await sessionsOf(page, taskId)) if (s.event_id) await call(page, 'DELETE', `/api/events/${s.event_id}`)
  await call(page, 'DELETE', `/api/tasks/${taskId}`)
}
const rowOf = (page: Page, title: string) => page.locator('.task-item', { hasText: title })

test('a task is booked once: shown once in the calendar, a second booking is refused, a reschedule moves the same session', async ({ page, setLanguage, guard }) => {
  // The refused second booking is the point of this test: the browser logs the expected 409 as a console error.
  guard.allowConsole(/status of 409/)
  await setLanguage('en')
  const { id, title, zone } = await makeTask(page, 'once')
  try {
    await page.goto('/tasks')
    const row = rowOf(page, title)
    await row.locator('.task-body').click()
    await expect(row.locator('.sched-badge')).toHaveCount(0)            // not scheduled: no badge
    const choices = row.getByRole('group', { name: 'Schedule' })
    await expect(choices.locator('button').first()).toBeVisible()

    // Book it with a double click: one request, one session.
    const posts: string[] = []
    page.on('request', r => { if (r.method() === 'POST' && /\/api\/tasks\/\d+\/schedule$/.test(r.url())) posts.push(r.headers()['idempotency-key'] ?? '') })
    const booked = page.waitForResponse(r => /\/api\/tasks\/\d+\/schedule$/.test(r.url()) && r.request().method() === 'POST')
    await choices.locator('button').first().dblclick()
    const response = await booked
    expect(response.status()).toBe(201)
    const event = (await response.json()).data as { id: number; task_id: number; starts_at: string; ends_at: string }
    expect(event.task_id).toBe(id)
    await page.waitForTimeout(400)
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(await sessionsOf(page, id)).toHaveLength(1)

    // The list now says so: a badge with the local time of the session (not the deadline), the length apart, and no booking chips.
    const badge = row.locator('.sched-badge')
    await expect(badge).toBeVisible()
    await expect(badge).toContainText('Scheduled')
    await expect(badge.locator('time')).toContainText(clock(event.starts_at, zone))
    await expect(badge.locator('time')).toHaveAttribute('datetime', /./)
    await expect(row.locator('.due-label')).toHaveText('Due')
    await expect(row.locator('.sched-duration')).toContainText('30 min')
    await expect(row.getByRole('group', { name: 'Schedule' })).toHaveCount(0)
    await expect(row.getByRole('link', { name: 'View in calendar' })).toBeVisible()
    await expect(row.getByRole('button', { name: 'Reschedule' })).toBeVisible()
    expect(await a11yViolations(page, `.task-item[data-task="${id}"]`)).toEqual([])

    // View in calendar: opens on that day with the session focused, and it is drawn exactly once.
    await row.getByRole('link', { name: 'View in calendar' }).click()
    await expect(page).toHaveURL(new RegExp(`/calendar\\?date=\\d{4}-\\d{2}-\\d{2}&session=${event.id}`))
    const drawn = page.locator(`[data-session="${event.id}"]`)
    await expect(drawn).toHaveCount(1)
    await expect(drawn).toBeFocused()
    await expect(drawn).toContainText(title)
    await expect(page.locator('[data-session]', { hasText: title })).toHaveCount(1)

    // A second booking is refused by the server, and nothing was added.
    const again = await call(page, 'POST', `/api/tasks/${id}/schedule`, { starts_at: new Date(Date.parse(event.starts_at) + 86_400_000).toISOString(), ends_at: new Date(Date.parse(event.ends_at) + 86_400_000).toISOString() }, { 'Idempotency-Key': crypto.randomUUID() })
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('task_already_scheduled')
    const viaEvents = await call(page, 'POST', '/api/events', { title, task_id: id, kind: 'flexible', starts_at: new Date(Date.parse(event.starts_at) + 2 * 86_400_000).toISOString(), ends_at: new Date(Date.parse(event.ends_at) + 2 * 86_400_000).toISOString() })
    expect(viaEvents.status).toBe(409)
    expect(await sessionsOf(page, id)).toHaveLength(1)

    // Open the session: its details and Reschedule, which moves this event (same id, same count).
    await drawn.click()
    const panel = page.getByRole('region', { name: 'Task session' })
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('link', { name: title })).toHaveAttribute('href', `/tasks?task=${id}`)
    await expect(panel).toContainText('30 min')
    // Escape inside the dialog closes only the Reschedule choices; the dialog stays, and focus is back on the button. A second Escape closes the dialog.
    await panel.getByRole('button', { name: 'Reschedule' }).click()
    await expect(panel.getByRole('group', { name: 'Reschedule' }).locator('button').first()).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(panel.getByRole('group', { name: 'Reschedule' })).toHaveCount(0)
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Reschedule' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()

    await page.goto('/tasks')
    await row.locator('.task-body').click()
    await row.getByRole('button', { name: 'Reschedule' }).click()
    const moveGroup = row.getByRole('group', { name: 'Reschedule' })
    await expect(moveGroup.locator('button').first()).toBeFocused()
    const moved = page.waitForResponse(r => /\/api\/tasks\/\d+\/schedule$/.test(r.url()) && r.request().method() === 'PUT')
    await moveGroup.locator('button.filter-chip').last().click()
    expect((await moved).status()).toBe(200)
    const after = await sessionsOf(page, id)
    expect(after).toHaveLength(1)
    expect(after[0].event_id).toBe(event.id)
    expect(after[0].starts_at).not.toBe(event.starts_at)
    await expect(row.locator('.sched-badge time')).toContainText(clock(after[0].starts_at, zone))
    await expect(row.getByRole('group', { name: 'Schedule' })).toHaveCount(0)
  } finally {
    await cleanup(page, id)
  }
})

test('a stale list cannot book twice: the server says it is already scheduled, the row explains and offers both ways forward', async ({ page, setLanguage, guard }) => {
  // The refused second booking is the point of this test: the browser logs the expected 409 as a console error.
  guard.allowConsole(/status of 409/)
  await setLanguage('en')
  const { id, title } = await makeTask(page, 'stale')
  try {
    await page.goto('/tasks')
    const row = rowOf(page, title)
    await row.locator('.task-body').click()
    const choices = row.getByRole('group', { name: 'Schedule' })
    await expect(choices.locator('button').first()).toBeVisible()

    // Meanwhile (another tab, another device) the same task gets booked.
    const slot = await page.evaluate(() => { const s = new Date(Date.now() + 3 * 86_400_000); s.setUTCHours(10, 0, 0, 0); return { starts_at: s.toISOString(), ends_at: new Date(s.getTime() + 30 * 60_000).toISOString() } })
    const first = await call(page, 'POST', `/api/tasks/${id}/schedule`, slot, { 'Idempotency-Key': crypto.randomUUID() })
    expect(first.status).toBe(201)

    // The stale list still shows the chips. Tapping one is answered with 409 and no second session exists.
    await choices.locator('button').first().click()
    const alert = row.getByRole('alert')
    await expect(alert).toContainText('This task is already scheduled.')
    await expect(alert).toBeFocused()
    await expect(alert.getByRole('link', { name: 'View in calendar' })).toBeVisible()
    await expect(alert.getByRole('button', { name: 'Reschedule' })).toBeVisible()
    await expect(page.getByText(/“.*” scheduled/)).toHaveCount(0)      // no success toast
    await expect(row.locator('.sched-badge')).toBeVisible()            // and the row now shows the real state
    expect(await sessionsOf(page, id)).toHaveLength(1)

    // The same key again returns the same session, never a second one.
    const key = crypto.randomUUID(), other = { starts_at: new Date(Date.parse(slot.starts_at) + 86_400_000).toISOString(), ends_at: new Date(Date.parse(slot.ends_at) + 86_400_000).toISOString() }
    const replayA = await call(page, 'POST', `/api/tasks/${id}/schedule`, other, { 'Idempotency-Key': key })
    const replayB = await call(page, 'POST', `/api/tasks/${id}/schedule`, other, { 'Idempotency-Key': key })
    expect([replayA.status, replayB.status].every(s => [200, 201, 409].includes(s))).toBe(true)
    expect(await sessionsOf(page, id)).toHaveLength(1)
  } finally {
    await cleanup(page, id)
  }
})

test('the scheduled row reads right in Arabic (right to left) and on a narrow screen', async ({ page, setLanguage }) => {
  await setLanguage('ar')
  const { id, title } = await makeTask(page, 'ar')
  try {
    const slot = await page.evaluate(() => { const s = new Date(Date.now() + 2 * 86_400_000); s.setUTCHours(9, 0, 0, 0); return { starts_at: s.toISOString(), ends_at: new Date(s.getTime() + 30 * 60_000).toISOString() } })
    expect((await call(page, 'POST', `/api/tasks/${id}/schedule`, slot, { 'Idempotency-Key': crypto.randomUUID() })).status).toBe(201)
    await page.setViewportSize({ width: 320, height: 700 })
    await page.goto('/tasks')
    const row = rowOf(page, title)
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    await expect(row.locator('.sched-badge')).toContainText('مجدولة')
    await expect(row.locator('.due-label')).toHaveText('الاستحقاق')
    await expect(row.locator('.sched-duration')).toContainText('30 دقيقة')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    await row.locator('.task-body').click()
    await expect(row.getByRole('link', { name: 'عرض في التقويم' })).toBeVisible()
    await expect(row.getByRole('button', { name: 'إعادة الجدولة' })).toBeVisible()
    expect(await a11yViolations(page, `.task-item[data-task="${id}"]`)).toEqual([])
  } finally {
    await cleanup(page, id)
  }
})

for (const [language, letter] of [['ar', 'ب'], ['nl', 'x']] as const) {
  test(`a long unbroken title is not clipped at 320px (${language})`, async ({ page, setLanguage }) => {
    await setLanguage('en')
    const { id, title } = await makeTask(page, `long-${language}`, `E2E ${letter.repeat(40)}${Date.now()}`)
    try {
      expect((await call(page, 'PUT', '/api/settings', { language })).status).toBe(200)
      const slot = await page.evaluate(() => { const s = new Date(Date.now() + 2 * 86_400_000); s.setUTCHours(9, 0, 0, 0); return { starts_at: s.toISOString(), ends_at: new Date(s.getTime() + 30 * 60_000).toISOString() } })
      expect((await call(page, 'POST', `/api/tasks/${id}/schedule`, slot, { 'Idempotency-Key': crypto.randomUUID() })).status).toBe(201)
      await page.setViewportSize({ width: 320, height: 700 })
      await page.goto('/tasks')
      const body = rowOf(page, title).locator('.task-body')
      await expect(body).toBeVisible()
      expect(await body.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
      expect(await body.locator('strong').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
      expect(await rowOf(page, title).evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    } finally {
      await call(page, 'PUT', '/api/settings', { language: 'en' })
      await cleanup(page, id)
    }
  })
}
