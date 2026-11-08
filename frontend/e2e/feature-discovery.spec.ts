import AxeBuilder from '@axe-core/playwright'
import { test, expect } from './fixtures'

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']
const hint = { id: 'capture-hint', feature: 'quick-capture', target: 'quick-add', route: '/tasks', text: 'Type a phrase like “tomorrow 5pm” and LifeOS reads the time.' }

/** Only the discovery endpoints are stubbed; the rest of the app is the real one. */
async function stub(page: import('@playwright/test').Page, guide: unknown) {
  const recorded: string[] = []
  await page.route('**/api/discovery/bootstrap**', route => route.fulfill({ json: { data: { announcement: null, update_required: false, counts: { unseen_updates: 0 }, preferences: { hints_enabled: true } } } }))
  await page.route('**/api/discovery/guide**', route => route.fulfill({ json: { data: guide } }))
  await page.route('**/api/discovery/states/**', route => { recorded.push(`${route.request().url().split('/states/')[1]} ${JSON.parse(route.request().postData() ?? '{}').action}`); return route.fulfill({ json: { data: {} } }) })
  await page.route('**/api/discovery/features/**/try**', route => { recorded.push('try'); return route.fulfill({ json: { data: { available: true, reason: null, route: '/tasks', tour: null } } }) })
  return recorded
}

test('a hint appears once next to its target without taking focus, and is accessible', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const recorded = await stub(page, { new: [], hints: [hint] })
  await page.goto('/tasks')
  const bubble = page.getByTestId('hint-bubble')
  await expect(bubble).toBeVisible({ timeout: 25_000 })
  await expect(bubble).toContainText('tomorrow 5pm')
  await expect.poll(() => recorded).toContain('hint/capture-hint seen')
  const box = await bubble.boundingBox(), size = page.viewportSize()!
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(size.width)
  expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="hint-bubble"]'))).toBeNull()
  // Contrast is measured on the settled bubble, not halfway through its fade-in.
  await bubble.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)))
  const violations = (await new AxeBuilder({ page }).include('[data-testid="hint-bubble"]').withTags(TAGS).analyze()).violations
  expect(violations.map(v => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([])
  await page.keyboard.press('Escape')
  await expect(bubble).toBeHidden()
  await expect.poll(() => recorded).toContain('hint/capture-hint dismissed')
})

test('the menu marks a new feature and opening its screen clears the mark', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const recorded = await stub(page, { new: [{ id: 'quick-capture', route: '/tasks', name: 'Quick capture' }], hints: [] })
  await page.goto('/')
  const size = page.viewportSize()!
  if (size.width <= 900) await page.getByRole('button', { name: /menu/i }).first().click()
  await expect(page.getByTestId('new-badge').first()).toBeVisible({ timeout: 25_000 })
  await page.getByRole('link', { name: /Tasks/ }).first().click()
  await expect(page).toHaveURL(/\/tasks$/)
  await expect.poll(() => recorded).toContain('try')
})

test('nothing is shown while a dialog is open', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await stub(page, { new: [], hints: [hint] })
  await page.goto('/tasks')
  await page.evaluate(() => { const d = document.createElement('dialog'); d.setAttribute('open', ''); d.textContent = 'busy'; document.body.append(d) })
  await page.waitForTimeout(3000)
  await expect(page.getByTestId('hint-bubble')).toHaveCount(0)
})
