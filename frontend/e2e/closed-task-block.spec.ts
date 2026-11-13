import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * Finishing a task early frees its later calendar slot: the block stays on the calendar (marked `task_closed`), but it no longer holds the
 * time, so another booking over it is accepted. Real server, throwaway database; everything made here is removed at the end.
 */
type Reply = { status: number; body: { data?: unknown } & Record<string, unknown> }
async function call(page: Page, method: string, path: string, body?: unknown): Promise<Reply> {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, path, body] as const)
}
type Item = { event_id: number | null; task_id: number | null; title: string; task_closed?: boolean }

async function freeDay(page: Page, from: number) {
  for (let i = from; i < from + 40; i++) {
    const day = new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10)
    const r = await call(page, 'GET', `/api/calendar?from=${encodeURIComponent(`${day}T06:00:00Z`)}&to=${encodeURIComponent(`${day}T14:00:00Z`)}`)
    if (r.status === 200 && (r.body.data as unknown[]).length === 0) return day
  }
  throw new Error('no free day found')
}

test('a completed task frees its slot, the block stays and is marked closed, and reopening makes it hold the time again', async ({ page, setLanguage, guard }, testInfo) => {
  guard.allowConsole(/status of 42[29]/)   // the refused overlap after reopening is part of the test
  await setLanguage('en')
  await page.goto('/')
  const day = await freeDay(page, testInfo.project.name === 'mobile' ? 36 : 30)
  const slot = (from: string, to: string) => ({ starts_at: `${day}T${from}:00Z`, ends_at: `${day}T${to}:00Z` })
  const made = await call(page, 'POST', '/api/tasks', { title: `E2E closed ${Date.now()}`, status: 'todo', priority: 'medium', estimated_minutes: 30 })
  expect(made.status).toBe(201)
  const taskId = (made.body.data as { id: number }).id
  const created: number[] = []
  try {
    expect((await call(page, 'POST', `/api/tasks/${taskId}/schedule`, slot('09:00', '09:30'))).status).toBe(201)
    // Open task: the slot is taken.
    expect((await call(page, 'POST', '/api/events', { title: 'E2E clash', ...slot('09:15', '09:45') })).status).toBe(422)

    // Complete it: the time is free, the block is still there and says so.
    expect((await call(page, 'PATCH', `/api/tasks/${taskId}`, { status: 'completed' })).status).toBe(200)
    const booked = await call(page, 'POST', '/api/events', { title: 'E2E takes the slot', ...slot('09:00', '09:30') })
    expect(booked.status).toBe(201)
    created.push((booked.body.data as { id: number }).id)
    const list = await call(page, 'GET', `/api/calendar?from=${encodeURIComponent(`${day}T06:00:00Z`)}&to=${encodeURIComponent(`${day}T14:00:00Z`)}`)
    const items = list.body.data as Item[]
    expect(items.find(i => i.task_id === taskId)?.task_closed).toBe(true)
    expect(items.find(i => i.title === 'E2E takes the slot')?.task_closed).toBe(false)

    // The calendar page draws the closed block with its own class and does not call it an overlap.
    await page.goto(`/calendar?date=${day}`)
    await expect(page.locator('.grid-event.closed, .agenda-item.closed, .calendar-event.closed').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.conflict-chip')).toHaveCount(0)

    // Reopen it: the block holds its time again for new bookings.
    await page.goto('/')
    expect((await call(page, 'PATCH', `/api/tasks/${taskId}`, { status: 'todo' })).status).toBe(200)
    expect((await call(page, 'POST', '/api/events', { title: 'E2E again', ...slot('09:00', '09:30') })).status).toBe(422)
  } finally {
    await page.goto('/')
    for (const id of created) await call(page, 'DELETE', `/api/events/${id}`)
    const list = await call(page, 'GET', `/api/calendar?from=${encodeURIComponent(`${day}T00:00:00Z`)}&to=${encodeURIComponent(`${day}T23:59:00Z`)}`)
    for (const i of (list.body.data as Item[]).filter(i => i.task_id === taskId && i.event_id)) await call(page, 'DELETE', `/api/events/${i.event_id}`)
    await call(page, 'DELETE', `/api/tasks/${taskId}`)
  }
})
