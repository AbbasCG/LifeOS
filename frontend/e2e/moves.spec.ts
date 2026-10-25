import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

/** Call the API as the signed-in demo user. */
async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ([method, path, body]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(path as string, { method: method as string, credentials: 'include', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-XSRF-TOKEN': token }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, data: r.status === 204 ? null : await r.json() }
  }, [method, path, body] as const)
}

/** Where an event currently starts, read through the calendar range endpoint (as an ISO string). */
async function startOf(page: Page, id: number): Promise<string | undefined> {
  const from = new Date(Date.now() - 86400000).toISOString(), to = new Date(Date.now() + 14 * 86400000).toISOString()
  const list = (await call(page, 'GET', `/api/calendar?from=${from}&to=${to}`)).data?.data ?? []
  const found = list.find((e: { id: number; event_id?: number }) => (e.event_id ?? e.id) === id)
  return found ? new Date(found.starts_at).toISOString() : undefined
}

/** UTC ISO string for a wall-clock time in a time zone. */
function zoned(date: string, time: string, tz: string): string {
  const guess = new Date(`${date}T${time}:00Z`)
  const local = new Date(guess.toLocaleString('en-US', { timeZone: tz })), utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }))
  return new Date(guess.getTime() - (local.getTime() - utc.getTime())).toISOString()
}

test('a week plan moves only flexible blocks off an overloaded day, after approval, and undoes', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const tz = (await call(page, 'GET', '/api/settings')).data?.timezone ?? 'Europe/Amsterdam'
  // A work day two to six days ahead, made fully booked: every free gap in working hours (09:00–17:30) gets a fixed
  // appointment, except the largest, which gets one flexible block.
  const day = [2, 3, 4, 5, 6].map(n => new Date(Date.now() + n * 86400000)).find(d => ![0, 6].includes(new Date(d.toLocaleString('en-US', { timeZone: tz })).getDay()))!
  const date = new Date(day.toLocaleString('en-US', { timeZone: tz })).toLocaleDateString('en-CA')
  const open = Date.parse(zoned(date, '09:00', tz)), close = Date.parse(zoned(date, '17:30', tz))
  const existing: { starts_at: string; ends_at: string }[] = (await call(page, 'GET', `/api/calendar?from=${new Date(open).toISOString()}&to=${new Date(close).toISOString()}`)).data?.data ?? []
  const gaps: [number, number][] = []
  let cursor = open
  for (const e of [...existing].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))) {
    if (Date.parse(e.starts_at) > cursor) gaps.push([cursor, Math.min(Date.parse(e.starts_at), close)])
    cursor = Math.max(cursor, Date.parse(e.ends_at))
  }
  if (cursor < close) gaps.push([cursor, close])
  const largest = gaps.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a))
  const fixedIds: number[] = [], created: number[] = []
  for (const gap of gaps.filter(g => g[1] - g[0] >= 60000)) {
    const flexible = gap === largest
    const r = await call(page, 'POST', '/api/events', { title: flexible ? 'E2E flexible block' : 'E2E appointment', kind: flexible ? 'flexible' : 'fixed', starts_at: new Date(gap[0]).toISOString(), ends_at: new Date(gap[1]).toISOString() })
    expect(r.status, JSON.stringify(r.data)).toBe(201)
    created.push(r.data.data.id)
    if (!flexible) fixedIds.push(r.data.data.id)
  }

  await page.goto('/assistant')
  const composer = page.getByRole('textbox', { name: 'Message' })
  await composer.fill('Plan my week around my meetings')
  await composer.press('Enter')
  const reply = page.locator('.chat-turn.assistant').last()
  const card = reply.locator('.proposal-card')
  await expect(card).toBeVisible()
  await expect(reply.locator('.plan-moves')).toContainText('Fixed, recurring and connected events never move')
  const conversation = new URL(page.url()).searchParams.get('c')!
  const messages = (await call(page, 'GET', `/api/copilot/conversations/${conversation}`)).data.messages
  const actions: { id: string; type: string; event_id?: number; starts_at: string; from_starts_at?: string }[] = messages.at(-1).proposal.actions
  const moves = actions.filter(a => a.type === 'move_event')
  expect(moves.length, 'the overloaded day gets a move').toBeGreaterThan(0)
  expect(moves.filter(m => fixedIds.includes(m.event_id!)), 'fixed appointments never move').toEqual([])
  const first = card.locator('.proposal-actions li').first()
  await expect(first.getByText('Moves an existing block')).toBeVisible()
  await expect(first.getByText('No conflicts at the new time')).toBeVisible()

  // Approve only the first move (moves are listed first).
  for (const box of await card.locator('input[type=checkbox]').all()) await box.uncheck()
  await first.locator('input[type=checkbox]').check()
  await card.locator('.toolbar button.primary').click()
  await expect(card.getByText('Applied')).toBeVisible()
  expect(await startOf(page, moves[0].event_id!)).toBe(new Date(moves[0].starts_at).toISOString())
  for (const id of fixedIds) expect(await startOf(page, id)).toBeDefined()

  await card.getByRole('button', { name: /Undo these changes/ }).click()
  await expect(card.getByText('Undone')).toBeVisible()
  expect(await startOf(page, moves[0].event_id!)).toBe(new Date(moves[0].from_starts_at!).toISOString())

  // Keeping everything in place removes the moves from the next version.
  await reply.locator('.plan-moves').getByRole('button', { name: 'Keep everything in place' }).click()
  const kept = page.locator('.chat-turn.assistant').last()
  await expect(kept.locator('.plan-moves')).toContainText('Nothing moves')
  await expect(kept.getByText('Moves an existing block')).toHaveCount(0)

  for (const id of created) await call(page, 'DELETE', `/api/events/${id}`)
  const history = page.getByRole('button', { name: 'History', exact: true })
  if (await history.isVisible()) await history.click()
  page.once('dialog', d => void d.accept())
  await page.getByRole('button', { name: /^Delete “Plan my week around my meetings”/ }).click()
})
