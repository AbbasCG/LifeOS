import { test, expect, field, pick, zonedInstant } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * Typed times mean the ACCOUNT's timezone. The browser here is in Los Angeles (or Auckland) while the demo account is in Amsterdam, so a
 * form that still read the browser's clock would store 09:00 as 09:00 Los Angeles, and the calendar and the list badge (account time)
 * would show something else. Real Laravel server, throwaway database; everything made here is removed at the end.
 */
async function call(page: Page, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return page.evaluate(async ([m, p, b, h]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token, ...(h as Record<string, string>) }, body: b ? JSON.stringify(b) : undefined })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, path, body, headers] as const)
}
type Occurrence = { event_id: number | null; task_id: number | null; starts_at: string; ends_at: string }
async function sessionsOf(page: Page, taskId: number) {
  const from = new Date(Date.now() - 86_400_000).toISOString(), to = new Date(Date.now() + 60 * 86_400_000).toISOString()
  const r = await call(page, 'GET', `/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
  expect(r.status).toBe(200)
  return (r.body.data as Occurrence[]).filter(o => o.task_id === taskId)
}
/** A day (about `n` days ahead) with nothing in the calendar between 06:00Z and 14:00Z, so 09:00 account time is free. */
async function freeDay(page: Page, n: number) {
  for (let i = n; i < n + 40; i++) {
    const day = new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10)
    const r = await call(page, 'GET', `/api/calendar?from=${encodeURIComponent(`${day}T06:00:00Z`)}&to=${encodeURIComponent(`${day}T14:00:00Z`)}`)
    if (r.status === 200 && (r.body.data as unknown[]).length === 0) return day
  }
  throw new Error('no free day found')
}
async function makeTask(page: Page, label: string, due: string | null = null) {
  await page.goto('/')
  const zone = (await call(page, 'GET', '/api/settings')).body.timezone as string
  const title = `E2E zone-times ${label} ${Date.now()}`
  const made = await call(page, 'POST', '/api/tasks', { title, status: 'todo', priority: 'medium', estimated_minutes: 30, due_at: due })
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

for (const browserZone of ['America/Los_Angeles', 'Pacific/Auckland']) {
  test.describe(`browser in ${browserZone}`, () => {
    test.use({ timezoneId: browserZone })

    test('a typed session start of 09:00 is 09:00 on the calendar and in the list badge, and the deadline never moves', async ({ page, setLanguage }, testInfo) => {
      await setLanguage('en')
      const day = await freeDay(page, 21 + (testInfo.project.name === 'mobile' ? 9 : 0) + (browserZone === 'Pacific/Auckland' ? 3 : 0))
      const { id, title, zone } = await makeTask(page, 'session')
      const wall = (hm: string) => zonedInstant(`${day}T${hm}`, zone)
      try {
        // The task has a deadline of 17:00 account time, set through the API (an instant, as the server stores it).
        const due = zonedInstant(`${day}T17:00`, zone)
        expect((await call(page, 'PATCH', `/api/tasks/${id}`, { due_at: due })).status).toBe(200)

        let dialog = await openDialog(page, title)
        // The deadline field shows the account's 17:00, and a quiet note says which zone the fields use.
        await expect(dialog.locator('.rf-deadline .dtp-trigger')).toHaveAttribute('data-value', `${day}T17:00`)
        await expect(dialog.getByText(`Times are in ${zone}`).first()).toBeVisible()
        await pick(page, field(dialog, 'Execution start'), `${day}T09:00`)
        await dialog.getByRole('button', { name: 'Save' }).click()
        await expect(dialog).toBeHidden()

        // The server has the session at 09:00 to 09:30 account time (not browser time), and the deadline is exactly as it was.
        const made = await sessionsOf(page, id)
        expect(made).toHaveLength(1)
        expect(Date.parse(made[0].starts_at)).toBe(Date.parse(wall('09:00'))); expect(Date.parse(made[0].ends_at)).toBe(Date.parse(wall('09:30')))
        expect(Date.parse(((await call(page, 'GET', `/api/tasks/${id}`)).body as { data: { due_at: string } }).data.due_at)).toBe(Date.parse(due))

        // The list badge says 09:00, the calendar block says 09:00, and reopening the dialog shows 09:00 in the field.
        await page.goto('/tasks')
        const row = page.locator('.task-item', { hasText: title })
        await expect(row.locator('.sched-badge time')).toContainText('09:00')
        await expect(row.locator('.sched-badge time')).toContainText('09:30')
        await page.goto(`/calendar?date=${day}`)
        const block = page.locator('[data-session]', { hasText: title })
        await expect(block).toHaveCount(1)
        await expect(block).toContainText('09:00')
        dialog = await openDialog(page, title)
        await expect(field(dialog, 'Execution start')).toHaveAttribute('data-value', `${day}T09:00`)
        await expect(field(dialog, 'Execution end')).toHaveAttribute('data-value', `${day}T09:30`)
      } finally { await cleanup(page, id) }
    })

    test('a typed deadline of 09:00 is stored and shown as 09:00 account time, and reopening shows it unchanged', async ({ page, setLanguage }) => {
      await setLanguage('en')
      const { id, title, zone } = await makeTask(page, 'deadline')
      const day = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10)
      try {
        const dialog = await openDialog(page, title)
        await pick(page, field(dialog, 'Deadline'), `${day}T09:00`)
        await dialog.getByRole('button', { name: 'Save' }).click()
        await expect(dialog).toBeHidden()
        const saved = ((await call(page, 'GET', `/api/tasks/${id}`)).body as { data: { due_at: string } }).data
        expect(Date.parse(saved.due_at)).toBe(Date.parse(zonedInstant(`${day}T09:00`, zone)))
        const reopened = await openDialog(page, title)
        await expect(reopened.locator('.rf-deadline .dtp-trigger')).toHaveAttribute('data-value', `${day}T09:00`)
      } finally { await cleanup(page, id) }
    })
  })
}

test.describe('browser in the account zone', () => {
  test.use({ timezoneId: 'Europe/Amsterdam' })
  test('says nothing about zones when the device is already on the account clock', async ({ page, setLanguage }) => {
    await setLanguage('en')
    const { id, title, zone } = await makeTask(page, 'quiet')
    try {
      expect(zone).toBe('Europe/Amsterdam')
      const dialog = await openDialog(page, title)
      await expect(dialog.locator('.rf-deadline')).toBeVisible()
      await expect(dialog.getByText(/Times are in/)).toHaveCount(0)
    } finally { await cleanup(page, id) }
  })
})
