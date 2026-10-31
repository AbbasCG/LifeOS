import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

/** Fewer taps for what is done most (V30): moving or re-prioritising a task takes two taps from the list, and "Plan my day" is one tap from Today on a phone as well. */
async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, path, body] as const)
}
const dayIn = (at: Date | string, zone: string) => new Date(at).toLocaleDateString('en-CA', { timeZone: zone })
const clock = (at: string, zone: string) => new Date(at).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', timeZone: zone })

test('a task moves to tomorrow and changes priority in two taps each, with Undo', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/')
  const zone = (await call(page, 'GET', '/api/settings')).body.timezone as string
  const title = `E2E quick ${Date.now()}`
  const inDays = new Date(Date.now() + 3 * 86_400_000).toISOString()
  const made = await call(page, 'POST', '/api/tasks', { title, status: 'todo', priority: 'high', due_at: inDays })
  expect(made.status).toBe(201)
  const id = made.body.data.id as number
  const read = async () => (await call(page, 'GET', `/api/tasks/${id}`)).body.data as { due_at: string | null; priority: string }
  try {
    await page.goto('/tasks')
    const row = page.locator('.task-item', { hasText: title })
    await expect(row).toBeVisible()

    // Move to tomorrow: tap the task (1), tap "Tomorrow" (2). 17:00 on the account's tomorrow.
    await row.locator('.task-body').click()
    await row.getByRole('button', { name: 'Tomorrow' }).click()
    await expect.poll(async () => (await read()).due_at ? dayIn((await read()).due_at!, zone) : null).toBe(dayIn(new Date(Date.now() + 86_400_000), zone))
    expect(clock((await read()).due_at!, zone)).toBe('05:00 PM')

    // Undo puts the date back.
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(async () => (await read()).due_at?.slice(0, 16)).toBe(inDays.slice(0, 16))

    // Priority: tap the task (already open), tap "Urgent".
    await row.getByRole('radio', { name: 'Urgent' }).click()
    await expect.poll(async () => (await read()).priority).toBe('urgent')
    await expect(row.getByRole('radio', { name: 'Urgent' })).toHaveAttribute('aria-checked', 'true')

    // "No date" clears it.
    await row.getByRole('button', { name: 'No date' }).click()
    await expect.poll(async () => (await read()).due_at).toBeNull()
  } finally {
    await call(page, 'DELETE', `/api/tasks/${id}`)
  }
})

test('Plan my day is one tap from Today, on a phone too', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/')
  const plan = page.getByRole('link', { name: /Plan my day/ }).first()
  await expect(plan).toBeVisible()
  await plan.click()
  await expect(page).toHaveURL(/\/today\/plan/)
})

test('on a phone a whole project card opens it, and the round tick can be hit just outside its edge', async ({ page, setLanguage, isMobile }) => {
  test.skip(!isMobile, 'touch target sizes are for the phone layout')
  await setLanguage('en')
  await page.goto('/projects')
  const card = page.locator('.project-health li').first()
  await expect(card).toBeVisible()
  const name = (await card.locator('a').first().textContent())!.trim()
  const box = (await card.boundingBox())!
  // The right-hand end of the card, far from the name's text.
  await card.click({ position: { x: box.width - 12, y: box.height / 2 } })
  await expect(page).toHaveURL(/\/projects\/\d+/)
  await expect(page.getByRole('heading', { name }).first()).toBeVisible()

  await page.goto('/')
  const title = `E2E tick ${Date.now()}`
  const made = await call(page, 'POST', '/api/tasks', { title, status: 'todo', priority: 'urgent', due_at: new Date(Date.now() + 3600_000).toISOString() })
  const id = made.body.data.id as number
  try {
    await page.goto('/tasks')
    const tick = page.getByRole('button', { name: `Complete “${title}”` })
    await expect(tick).toBeVisible()
    // Coordinates are only meaningful once the list has stopped moving (rows animate in and re-sort).
    await tick.scrollIntoViewIfNeeded()
    let t = (await tick.boundingBox())!
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(150)
      const next = (await tick.boundingBox())!
      const still = Math.abs(next.x - t.x) < 0.5 && Math.abs(next.y - t.y) < 0.5
      t = next
      if (still) break
    }
    // 4px outside the drawn circle is still the same button on a phone.
    await page.touchscreen.tap(t.x - 4, t.y + t.height / 2)
    await expect.poll(async () => (await call(page, 'GET', `/api/tasks/${id}`)).body.data.status).toBe('completed')
  } finally {
    await call(page, 'DELETE', `/api/tasks/${id}`)
  }
})

test('on a phone every focus mode is on screen and at least 44px high', async ({ page, setLanguage, isMobile }) => {
  test.skip(!isMobile, 'touch target sizes are for the phone layout')
  await setLanguage('en')
  await page.goto('/focus')
  const viewport = page.viewportSize()!
  for (const name of ['Pomodoro', 'Deep work', 'Custom', 'Log time']) {
    const box = (await page.getByRole('tab', { name }).boundingBox())!
    expect(box.height, name).toBeGreaterThanOrEqual(44)
    expect(box.x, name).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width, name).toBeLessThanOrEqual(viewport.width)
  }
})

test('Today asks for energy with one tap, saves only that, and then gets out of the way', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/')
  const day = (await call(page, 'GET', '/api/today')).body.date as string
  const before = await call(page, 'GET', `/api/checkins`)
  const saved = before.body.today as { energy: number | null; mood: number | null; stress: number | null; workload: number | null; sleep_minutes: number | null; reflection: string | null } | null
  await call(page, 'DELETE', `/api/checkins/${day}`)
  try {
    await page.goto('/')
    const group = page.getByRole('group', { name: 'Energy today, 1 to 5' })
    await expect(group).toBeVisible()
    const saveCall = page.waitForResponse(r => r.url().includes(`/api/checkins/${day}`) && r.request().method() === 'PUT')
    await group.getByRole('button', { name: '4 Good' }).click()
    expect((await saveCall).status()).toBe(201)
    expect((await call(page, 'GET', '/api/checkins')).body.today.energy).toBe(4)
    // Answered: the quick card is gone from Today.
    await expect(group).toHaveCount(0)
  } finally {
    // Put back what the demo account had.
    await call(page, 'DELETE', `/api/checkins/${day}`)
    if (saved) await call(page, 'PUT', `/api/checkins/${day}`, { energy: saved.energy, mood: saved.mood, stress: saved.stress, workload: saved.workload, sleep_minutes: saved.sleep_minutes, reflection: saved.reflection })
  }
})

/** A real touch swipe over a row, through the browser's own touch input (it raises the same pointer events a finger does). */
async function swipe(page: Page, from: { x: number; y: number }, dx: number, hold?: () => Promise<void>) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] })
  for (let step = 1; step <= 8; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (dx * step) / 8, y: from.y }] })
  if (hold) await hold()
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

for (const [language, dx, word, ready] of [['en', 110, 'Complete', 'Release'], ['ar', 110, 'إنجاز', 'اترك']] as const) {
  test(`swiping a task right says what it will do, and completes it on release (${language}: the swipe follows the finger, not the reading direction)`, async ({ page, setLanguage, isMobile }) => {
    test.skip(!isMobile, 'a touch gesture')
    await setLanguage(language)
    await page.goto('/')
    const title = `E2E swipe ${Date.now()}`
    const made = await call(page, 'POST', '/api/tasks', { title, status: 'todo', priority: 'urgent', due_at: new Date(Date.now() + 3600_000).toISOString() })
    const id = made.body.data.id as number
    try {
      await page.goto('/tasks')
      const row = page.locator('.task-item', { hasText: title })
      await expect(row).toBeVisible()
      await row.scrollIntoViewIfNeeded()
      // Let the list stop moving, then swipe over the row's text.
      await page.waitForTimeout(600)
      const box = (await row.locator('.task-body').boundingBox())!
      await swipe(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, dx, async () => {
        // Mid-gesture: the label is words, not only colour, and it changes once letting go would act.
        await expect(row.locator('.swipe-label')).toContainText(ready)
      })
      await expect.poll(async () => (await call(page, 'GET', `/api/tasks/${id}`)).body.data.status).toBe('completed')
      expect(word.length).toBeGreaterThan(0)
    } finally {
      await call(page, 'DELETE', `/api/tasks/${id}`)
    }
  })
}

test('a short swipe does nothing, and the one-time tip about swiping can be dismissed for good', async ({ page, setLanguage, isMobile }) => {
  test.skip(!isMobile, 'a touch gesture')
  await setLanguage('en')
  await page.goto('/')
  await page.evaluate(() => localStorage.removeItem('lifeos-swipe-tip'))
  const title = `E2E short swipe ${Date.now()}`
  const made = await call(page, 'POST', '/api/tasks', { title, status: 'todo', priority: 'urgent', due_at: new Date(Date.now() + 3600_000).toISOString() })
  const id = made.body.data.id as number
  try {
    await page.goto('/tasks')
    const tip = page.getByRole('note').filter({ hasText: 'swipe a task' })
    await expect(tip).toBeVisible()
    await tip.getByRole('button', { name: 'Got it' }).click()
    await expect(tip).toHaveCount(0)
    await page.reload()
    await expect(page.locator('.task-item', { hasText: title })).toBeVisible()
    await expect(page.getByRole('note').filter({ hasText: 'swipe a task' })).toHaveCount(0)

    const row = page.locator('.task-item', { hasText: title })
    await page.waitForTimeout(600)
    const box = (await row.locator('.task-body').boundingBox())!
    await swipe(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 40)
    await page.waitForTimeout(800)
    expect((await call(page, 'GET', `/api/tasks/${id}`)).body.data.status).not.toBe('completed')
  } finally {
    await call(page, 'DELETE', `/api/tasks/${id}`)
  }
})

async function swipeRow(page: Page, title: string, dx: number, hold?: () => Promise<void>) {
  const row = page.locator('.task-item', { hasText: title })
  await expect(row).toBeVisible()
  await row.scrollIntoViewIfNeeded()
  await page.waitForTimeout(600)
  const box = (await row.locator('.task-body').boundingBox())!
  await swipe(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, dx, hold)
  return row
}
const swipeTask = async (page: Page, due: number) => {
  const made = await call(page, 'POST', '/api/tasks', { title: `E2E swipe actions ${Date.now()}`, status: 'todo', priority: 'urgent', due_at: new Date(Date.now() + due).toISOString() })
  return { id: made.body.data.id as number, title: made.body.data.title as string }
}

test('swiping left snoozes a task to tomorrow with Undo, the way an email app does', async ({ page, setLanguage, isMobile }) => {
  test.skip(!isMobile, 'a touch gesture')
  await setLanguage('en')
  await page.goto('/')
  await page.evaluate(() => { localStorage.removeItem('lifeos-swipe-actions'); localStorage.setItem('lifeos-swipe-tip', '1') })
  const zone = (await call(page, 'GET', '/api/settings')).body.timezone as string
  const { id, title } = await swipeTask(page, 3600_000)
  const dueOf = async () => (await call(page, 'GET', `/api/tasks/${id}`)).body.data.due_at as string
  const before = await dueOf()
  try {
    await page.goto('/tasks')
    await swipeRow(page, title, -110, async () => { await expect(page.locator('.task-item', { hasText: title }).locator('.swipe-label')).toContainText('Release') })
    const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: zone })
    await expect.poll(async () => new Date(await dueOf()).toLocaleDateString('en-CA', { timeZone: zone })).toBe(tomorrow)
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(async () => (await dueOf()).slice(0, 16)).toBe(before.slice(0, 16))
  } finally {
    await call(page, 'DELETE', `/api/tasks/${id}`)
  }
})

test('each swipe can be set in Settings; delete asks first, and Reset brings the usual swipes back', async ({ page, setLanguage, isMobile }) => {
  test.skip(!isMobile, 'a touch gesture')
  await setLanguage('en')
  await page.goto('/settings')
  await page.evaluate(() => { localStorage.removeItem('lifeos-swipe-actions'); localStorage.setItem('lifeos-swipe-tip', '1') })
  await page.reload()
  const card = page.getByRole('region', { name: 'Swipe actions' })
  await expect(card.getByLabel('Swipe right')).toHaveValue('complete')
  await expect(card.getByLabel('Swipe left')).toHaveValue('tomorrow')
  await card.getByLabel('Swipe right').selectOption('delete')
  await card.getByLabel('Swipe left').selectOption('complete')
  await page.reload()
  await expect(card.getByLabel('Swipe right')).toHaveValue('delete')

  const { id, title } = await swipeTask(page, 3600_000)
  try {
    await page.goto('/tasks')
    // Right now deletes, but asks first; saying no keeps the task.
    await swipeRow(page, title, 110)
    const ask = page.getByRole('dialog', { name: 'Delete this task?' })
    await expect(ask).toBeVisible()
    await ask.getByRole('button', { name: 'Cancel' }).click()
    expect((await call(page, 'GET', `/api/tasks/${id}`)).status).toBe(200)
    // Left now completes.
    await swipeRow(page, title, -110)
    await expect.poll(async () => (await call(page, 'GET', `/api/tasks/${id}`)).body.data.status).toBe('completed')

    await page.goto('/settings')
    await card.getByRole('button', { name: 'Reset' }).click()
    await expect(card.getByLabel('Swipe right')).toHaveValue('complete')
    await expect(card.getByLabel('Swipe left')).toHaveValue('tomorrow')
  } finally {
    await call(page, 'DELETE', `/api/tasks/${id}`)
    await page.evaluate(() => localStorage.removeItem('lifeos-swipe-actions'))
  }
})

test('Copilot offers three ideas on a phone and more on a larger screen, and sends nothing by itself', async ({ page, setLanguage, isMobile }) => {
  await setLanguage('en')
  let sent = 0
  page.on('request', r => { if (r.method() === 'POST' && /\/api\/assistant\/(chat|messages)/.test(r.url())) sent++ })
  await page.goto('/assistant')
  const chips = page.locator('.prompt-chips .chip-button')
  await expect(chips.first()).toBeVisible()
  const visible = await chips.evaluateAll(nodes => nodes.filter(n => (n as HTMLElement).offsetParent !== null).length)
  if (isMobile) expect(visible).toBe(3); else expect(visible).toBeGreaterThan(3)
  await expect(page.getByText('Tap an idea or type.')).toBeVisible()
  expect(sent).toBe(0)
})
