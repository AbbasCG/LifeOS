import { test, expect } from './fixtures'
import { a11yViolations } from './axe'

const feature = (over = {}) => ({ id: 'quick-capture', category: 'tasks', name: 'Quick Capture in three languages', description: 'Write a task the way you speak.', route: '/tasks', release: 'r-one', date: '2026-11-08',
  can_try: true, unavailable_reason: null, tour: 'quick-capture-tour', tour_done: false, tried: false, is_new: true, ...over })
const english = [
  feature(),
  feature({ id: 'dutch-language', category: 'settings', name: 'Nederlands is available', description: 'Choose Nederlands in Settings.', route: '/settings', tour: null, is_new: false, tried: true }),
  feature({ id: 'night-owl', category: 'focus', name: 'Night owl mode', description: 'Dim the focus screen.', route: '/focus', can_try: false, unavailable_reason: 'setup_needed', tour: null, is_new: false }),
]
const arabic = [
  feature({ name: 'الالتقاط السريع بثلاث لغات', description: 'اكتب مهمتك كما تتحدث.' }),
  feature({ id: 'dutch-language', category: 'settings', name: 'اللغة الهولندية متاحة', description: 'اختر Nederlands من الإعدادات.', route: '/settings', tour: null, is_new: false, tried: true }),
]
const tour = { id: 'quick-capture-tour', version: 1, title: 'Quick Capture', state: { step_index: 0, completed: false, skipped: false },
  steps: [{ target: 'quick-add', route: null, reveal: null, placement: 'auto', optional: false, title: 'Add a task in one go', body: 'Open Quick add and write the task.' }] }

/** Only the discovery endpoints are stubbed; the app, its menu and its routes are the real ones. */
async function stub(page: import('@playwright/test').Page, features: unknown[]) {
  const seen: string[] = []
  await page.route('**/api/discovery/bootstrap**', route => route.fulfill({ json: { data: { announcement: null, update_required: false, counts: { unseen_updates: 0 }, preferences: { hints_enabled: true } } } }))
  await page.route('**/api/discovery/guide**', route => route.fulfill({ json: { data: { new: [], hints: [] } } }))
  await page.route('**/api/discovery/features?**', route => route.fulfill({ json: { data: features } }))
  await page.route('**/api/discovery/features/*/try**', route => { seen.push('try'); return route.fulfill({ json: { data: { available: true, reason: null, route: '/tasks', tour: 'quick-capture-tour' } } }) })
  await page.route('**/api/discovery/tours/**', route => route.fulfill({ json: { data: tour } }))
  await page.route('**/api/discovery/states/**', route => { seen.push(`${route.request().url().split('/states/')[1]} ${JSON.parse(route.request().postData() ?? '{}').action}`); return route.fulfill({ json: { data: {} } }) })
  return seen
}

for (const language of ['en', 'ar'] as const) {
  test(`the Discovery Center lists features, is accessible and fits the screen (${language})`, async ({ page, setLanguage }) => {
    await setLanguage(language)
    await stub(page, language === 'ar' ? arabic : english)
    await page.goto('/discover')
    await expect(page.getByRole('heading', { level: 1, name: language === 'ar' ? 'اكتشف' : 'Discover' })).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr')
    await expect(page.getByRole('heading', { level: 3 }).first()).toBeVisible()
    expect(await a11yViolations(page)).toEqual([])
    // Nothing spills sideways on a phone.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
  })
}

test('search narrows the list, and "Try now" opens the screen and starts the tour', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const seen = await stub(page, english)
  await page.goto('/discover')
  const search = page.getByRole('searchbox', { name: 'Search features' })
  await expect(search).toBeVisible({ timeout: 20_000 })
  await search.fill('night')
  await expect(page.getByRole('heading', { level: 3, name: /Night owl/ })).toBeVisible()
  await expect(page.getByRole('heading', { level: 3, name: /Quick Capture/ })).toHaveCount(0)
  await expect(page.getByText('Needs setup first.')).toBeVisible()
  await search.fill('')
  await page.getByRole('button', { name: 'Try now' }).first().click()
  await expect(page).toHaveURL(/\/tasks$/)
  await expect(page.getByTestId('tour-card')).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => seen).toContain('try')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('tour-card')).toBeHidden()
})

test('the menu has a Discover entry that opens the center', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await stub(page, english)
  await page.goto('/')
  await page.locator('#main').waitFor({ timeout: 20_000 })
  if ((page.viewportSize()?.width ?? 1440) <= 1100) await page.getByRole('button', { name: /menu/i }).first().click()
  await page.locator('[data-tour="nav-discover"]').click()
  await expect(page).toHaveURL(/\/discover$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Discover' })).toBeVisible()
})

test('suggestions, filters and the details dialog work, are accessible and fit the screen', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await stub(page, [...english, feature({ id: 'related', name: 'Related thing', category: 'tasks', date: '2026-10-02', is_new: false, tour: null })])
  await page.goto('/discover')
  await expect(page.getByRole('heading', { level: 2, name: 'Recommended for you' })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Tried', exact: true }).click()
  await expect(page.getByRole('heading', { level: 3, name: /Nederlands/ })).toBeVisible()
  await expect(page.getByRole('heading', { level: 3, name: /Quick Capture/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'All', exact: true }).click()
  await page.getByRole('button', { name: 'Details' }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  expect(await a11yViolations(page)).toEqual([])
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})
