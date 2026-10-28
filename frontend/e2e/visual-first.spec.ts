import { test, expect, noHorizontalOverflow } from './fixtures'
import type { Page } from '@playwright/test'

async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return r.status === 204 ? null : r.json().catch(() => null)
  }, [method, path, body] as const)
}

/** Cancel whatever focus session a journey started, so later tests start clean. */
async function stopFocus(page: Page) {
  const list = await call(page, 'GET', '/api/focus-sessions')
  for (const s of list?.data ?? list ?? []) if (s.status === 'running' || s.status === 'paused') await call(page, 'PATCH', `/api/focus-sessions/${s.id}`, { action: 'cancel' })
}

test('Today shows the next action at once, and focus starts with one tap', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await stopFocus(page)
  const started = Date.now()
  await page.goto('/')
  const now = page.locator('.now-card')
  await expect(now.getByRole('heading').first()).toBeVisible({ timeout: 3000 })
  expect(Date.now() - started).toBeLessThan(3000)
  await expect(page.getByRole('group', { name: 'Today’s schedule' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Progress today' })).toBeVisible()
  try {
    await now.getByRole('button', { name: 'Start focus' }).first().click()
    await expect(page).toHaveURL(/\/focus/)
    await expect(page.locator('.focus-dial')).toBeVisible()
  } finally {
    await stopFocus(page)
  }
  await noHorizontalOverflow(page)
})

test('a task is captured with one line and completed with one tap, with undo', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/tasks')
  const title = `E2E quick ${Date.now()}`
  try {
    // Desktop: the + in the top bar. Phone: the raised + in the bottom bar. Both open the same sheet.
    await page.getByRole('button', { name: 'Quick add' }).filter({ visible: true }).first().click()
    const sheet = page.getByRole('dialog', { name: 'Quick add' })
    await sheet.getByRole('textbox', { name: 'Task' }).fill(title)
    await sheet.getByRole('radio', { name: /Today/ }).click()
    await sheet.getByRole('radio', { name: /High/ }).click()
    await sheet.getByRole('button', { name: /Add task/ }).click()
    await expect(sheet).toBeHidden()
    const row = page.locator('.task-item', { hasText: title })
    await expect(row).toBeVisible()

    await row.getByRole('button', { name: `Complete “${title}”` }).click()
    await expect(page.getByText('Done. Nice work.')).toBeVisible()
    await expect(page.locator('.task-item', { hasText: title })).toHaveCount(0)
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(page.locator('.task-item', { hasText: title })).toBeVisible()
  } finally {
    const found = await call(page, 'GET', `/api/tasks?search=${encodeURIComponent(title)}&per_page=10`)
    for (const t of found?.data ?? []) if (t.title === title) await call(page, 'DELETE', `/api/tasks/${t.id}`)
  }
})

test('the calendar moves between days quickly and keeps the view', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/calendar')
  await page.waitForLoadState('networkidle')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  const heading = page.locator('.cal-bar h1')
  await expect(heading).toBeVisible()
  const first = await heading.textContent()
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(heading).not.toHaveText(first ?? '')
  await page.getByRole('button', { name: 'Previous', exact: true }).click()
  await expect(heading).toHaveText(first ?? '')
  await noHorizontalOverflow(page)
})

test('an AI proposal is readable at a glance', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/assistant')
  const composer = page.getByRole('textbox', { name: 'Message' })
  await composer.fill('Find two focus blocks this week')
  await composer.press('Enter')
  const card = page.locator('.chat-turn.assistant').last().locator('.proposal-card')
  try {
    await expect(card.getByText('Needs your approval')).toBeVisible()
    await expect(card.locator('.proposal-stats .chip').first()).toBeVisible()
    await expect(card.getByText('Nothing changes until you approve.', { exact: false })).toBeVisible()
    await card.getByRole('button', { name: 'Not now' }).click()
    await expect(card.getByText('Dismissed')).toBeVisible()
  } finally {
    const list = await call(page, 'GET', '/api/copilot/conversations?q=Find%20two%20focus')
    for (const c of list?.conversations ?? []) if (c.title?.startsWith('Find two focus blocks this week')) await call(page, 'DELETE', `/api/copilot/conversations/${c.id}`)
  }
})

test('the app is installable and its shortcut opens Quick add', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const manifest = await (await page.request.get('/manifest.webmanifest')).json()
  expect(manifest.display).toBe('standalone')
  expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true)
  expect(manifest.shortcuts.map((s: { url: string }) => s.url)).toEqual(expect.arrayContaining(['/?add=task', '/?focus=start', '/?log=habits', '/calendar']))
  await page.goto('/?add=task')
  const sheet = page.getByRole('dialog', { name: 'Quick add' })
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: 'Close' }).click()
  await expect(sheet).toBeHidden()
  await expect(page).not.toHaveURL(/add=task/)
})
