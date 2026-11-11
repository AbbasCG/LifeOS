import { test, expect } from './fixtures'
import type { Page, Locator } from '@playwright/test'

/**
 * The scrollbar is invisible everywhere, but nothing stops scrolling: wheel, keyboard and the modal behaviour all still work.
 * "No classic bar" = the box has no space reserved for one (offsetWidth - clientWidth minus borders is 0). Real server, throwaway database.
 */
// Headless Chromium hides scrollbars by default, which would make the space checks meaningless: show the classic ones so only our CSS can hide them.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })

type Reply = { status: number; body: { data?: { id: number } } }
async function call(page: Page, method: string, path: string, body?: unknown): Promise<Reply> {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, path, body] as const) as Promise<Reply>
}

const barSpace = (l: Locator) => l.evaluate(el => { const s = getComputedStyle(el); return (el as HTMLElement).offsetWidth - el.clientWidth - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth) })
const hidden = (l: Locator) => l.evaluate(el => getComputedStyle(el).scrollbarWidth)
const pageBarSpace = (page: Page) => page.evaluate(() => window.innerWidth - document.documentElement.clientWidth)


async function seed(page: Page) {
  await page.goto('/')
  const stamp = Date.now(), ids: number[] = []
  for (let i = 0; i < 14; i++) {
    const r = await call(page, 'POST', '/api/tasks', { title: `E2E scroll ${stamp} ${i}`, status: 'todo', priority: 'medium' })
    expect(r.status).toBe(201)
    ids.push(r.body.data!.id)
  }
  return { ids, stamp }
}
const cleanup = async (page: Page, ids: number[]) => { for (const id of ids) await call(page, 'DELETE', `/api/tasks/${id}`) }

/** Wheel then keyboard: the scroll position of `el` really moves. */
async function scrollsBy(page: Page, el: Locator) {
  await el.evaluate(e => { e.scrollTop = 0 })
  await el.hover()
  await page.mouse.wheel(0, 300)
  await expect.poll(() => el.evaluate(e => e.scrollTop)).toBeGreaterThan(0)
  await el.evaluate(e => { e.scrollTop = 0 })
  await el.evaluate(e => { (e as HTMLElement).tabIndex = Math.max((e as HTMLElement).tabIndex, -1); (e as HTMLElement).focus({ preventScroll: true }) })
  await page.keyboard.press('PageDown')
  await expect.poll(() => el.evaluate(e => e.scrollTop)).toBeGreaterThan(0)
  const afterPageDown = await el.evaluate(e => e.scrollTop)
  await page.keyboard.press('End')
  await expect.poll(() => el.evaluate(e => e.scrollTop)).toBeGreaterThan(afterPageDown)
}

for (const [language, theme] of [['en', 'light'], ['ar', 'dark']] as const) {
  test(`pages, lists and the task dialog scroll without a visible scrollbar (${language}, ${theme})`, async ({ page, setLanguage }, info) => {
    await setLanguage(language)
    await page.addInitScript(([t, l]) => { localStorage.setItem('lifeos-theme', t); localStorage.setItem('lifeos-language', l) }, [theme, language])
    const { ids, stamp } = await seed(page)
    try {
      await page.setViewportSize({ width: info.project.name === 'mobile' ? 412 : 1100, height: 380 })

      // Global rule is in force on the root and on arbitrary elements.
      await page.goto('/tasks')
      await expect(page.locator('.task-item').first()).toBeVisible()
      expect(await page.evaluate(() => [document.documentElement, document.body, document.querySelector('main')!].map(e => getComputedStyle(e).scrollbarWidth))).toEqual(['none', 'none', 'none'])

      // /tasks: the page scrolls (wheel, End key) and reserves no scrollbar space.
      expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true)
      expect(await pageBarSpace(page)).toBe(0)
      await page.mouse.move(200, 200)
      await page.mouse.wheel(0, 400)
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.locator('body').click({ position: { x: 5, y: 5 } })
      await page.keyboard.press('End')
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
      await page.keyboard.press('Home')
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)

      // The task dialog: long body scrolls, no bar space, background does not move while it is open, position restored on close.
      const row = page.locator('.task-item', { hasText: `E2E scroll ${stamp} 3` })
      await row.scrollIntoViewIfNeeded()
      await row.locator('.task-body').click()
      await row.getByRole('button', { name: /^Edit$|^تعديل$/ }).click()
      const dialog = page.locator('dialog.sheet[open]')
      await expect(dialog).toBeVisible()
      const body = dialog.locator('.sheet-body')
      expect(await body.evaluate(e => e.scrollHeight > e.clientHeight)).toBe(true)
      expect(await barSpace(body)).toBe(0)
      expect(await hidden(body)).toBe('none')
      await scrollsBy(page, body)
      const before = await page.evaluate(() => window.scrollY)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      expect(await page.evaluate(() => window.scrollY), 'closing the dialog leaves the page where it was').toBe(before)

      // Scroll lock while open: the page behind does not move when the wheel is used over the dialog.
      await row.getByRole('button', { name: /^Edit$|^تعديل$/ }).click()
      await expect(dialog).toBeVisible()
      const y = await page.evaluate(() => window.scrollY)
      await dialog.locator('.sheet-body').hover()
      await page.mouse.wheel(0, 3000)
      await page.waitForTimeout(250)
      expect(await page.evaluate(() => window.scrollY), 'the page behind the open dialog stays put').toBe(y)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      expect(await pageBarSpace(page)).toBe(0)
    } finally { await cleanup(page, ids) }
  })
}

test('the dashboard and the calendar time grid scroll without a visible scrollbar', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.setViewportSize({ width: 1100, height: 520 })
  await page.goto('/')
  await expect(page.locator('main')).toBeVisible()
  expect(await pageBarSpace(page)).toBe(0)
  await page.mouse.move(300, 300)
  await page.mouse.wheel(0, 300)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)

  await page.addInitScript(() => localStorage.setItem('lifeos-calendar-view', 'day'))
  await page.goto('/calendar')
  const grid = page.locator('.time-grid-body')
  await expect(grid).toBeVisible()
  expect(await grid.evaluate(e => e.scrollHeight > e.clientHeight)).toBe(true)
  expect(await barSpace(grid)).toBe(0)
  expect(await hidden(grid)).toBe('none')
  await scrollsBy(page, grid)
})
