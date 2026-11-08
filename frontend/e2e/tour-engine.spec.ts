import AxeBuilder from '@axe-core/playwright'
import { test, expect } from './fixtures'

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']
const t = (en: string, ar: string, language: string) => (language === 'ar' ? ar : en)
const tour = (language: 'en' | 'ar') => ({
  id: 'quick-tour', version: 1, title: t('Capture tour', 'جولة الالتقاط', language), state: { step_index: 0, completed: false, skipped: false },
  steps: [
    { target: 'quick-add', route: null, reveal: null, placement: 'auto', optional: false, title: t('Quick add', 'إضافة سريعة', language), body: t('Start here.', 'ابدأ من هنا.', language) },
    { target: 'nav-tasks', route: null, reveal: 'sidebar', placement: 'auto', optional: false, title: t('Tasks', 'المهام', language), body: t('Your list.', 'قائمتك.', language) },
    { target: 'nav-calendar', route: '/calendar', reveal: 'sidebar', placement: 'end', optional: false, title: t('Calendar', 'التقويم', language), body: t('Your week.', 'أسبوعك.', language) },
  ],
})

/** Only the discovery endpoints are stubbed; the app and its menu are the real ones. */
async function stub(page: import('@playwright/test').Page, language: 'en' | 'ar') {
  const recorded: string[] = []
  await page.route('**/api/discovery/bootstrap**', route => route.fulfill({ json: { data: { announcement: null, update_required: false, counts: { unseen_updates: 0 }, preferences: { hints_enabled: true } } } }))
  await page.route('**/api/discovery/guide**', route => route.fulfill({ json: { data: { new: [], hints: [] } } }))
  await page.route('**/api/discovery/tours/**', route => route.fulfill({ json: { data: tour(language) } }))
  await page.route('**/api/discovery/states/**', route => { const body = JSON.parse(route.request().postData() ?? '{}'); recorded.push(`${route.request().url().split('/states/')[1]} ${body.action}`); return route.fulfill({ json: { data: {} } }) })
  return recorded
}
const start = async (page: import('@playwright/test').Page) => {
  // The listener exists once the signed-in app shell has mounted.
  await page.locator('#main').waitFor({ timeout: 20_000 })
  await page.waitForTimeout(500)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lifeos:start-tour', { detail: { id: 'quick-tour' } })))
}

for (const language of ['en', 'ar'] as const) {
  test(`a tour points at each target, reveals the menu when needed, and stays on screen (${language})`, async ({ page, setLanguage }) => {
    await setLanguage(language)
    const recorded = await stub(page, language)
    await page.goto('/')
    await start(page)
    const card = page.getByTestId('tour-card')
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card).toBeFocused()
    await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr')
    const size = page.viewportSize()!
    const inside = async () => { const b = (await card.boundingBox())!; expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(size.width + 1); expect(b.y).toBeGreaterThanOrEqual(0); expect(b.y + b.height).toBeLessThanOrEqual(size.height + 1) }
    await expect(page.locator('.tour-dim.has-target')).toBeVisible()
    await inside()
    const violations = (await new AxeBuilder({ page }).include('[data-testid="tour-card"]').withTags(TAGS).analyze()).violations
    expect(violations.map(v => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([])

    await card.getByRole('button', { name: t('Next', 'التالي', language) }).click()
    await expect(card.getByRole('heading', { name: t('Tasks', 'المهام', language) })).toBeVisible()
    // The step's target is really on screen (the menu was opened on a phone).
    await expect(page.locator('[data-tour="nav-tasks"]')).toBeInViewport()
    await inside()

    await card.getByRole('button', { name: t('Next', 'التالي', language) }).click()
    await expect(card.getByRole('heading', { name: t('Calendar', 'التقويم', language) })).toBeVisible()
    await expect(page).toHaveURL(/\/calendar$/)
    await expect(page.locator('[data-tour="nav-calendar"]')).toBeInViewport()
    await inside()
    await card.getByRole('button', { name: t('Done', 'تم', language) }).click()
    await expect(card).toBeHidden()
    await expect.poll(() => recorded).toEqual(expect.arrayContaining(['tour/quick-tour started', 'tour/quick-tour step', 'tour/quick-tour completed']))
  })
}

test('Escape ends the tour and skipping is recorded', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const recorded = await stub(page, 'en')
  await page.goto('/')
  await start(page)
  const card = page.getByTestId('tour-card')
  await expect(card).toBeVisible({ timeout: 20_000 })
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden()
  await expect.poll(() => recorded).toContain('tour/quick-tour skipped')
})
