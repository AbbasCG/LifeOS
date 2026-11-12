import { test, expect } from './fixtures'
import { a11yViolations } from './axe'

const item = (over = {}) => ({ type: 'new', title: 'Quick capture', body: 'Type a phrase and LifeOS reads the time.', feature: 'quick-capture', can_try: true, unavailable_reason: null, tour: null, tried: false, is_new: true, link: null, ...over })
const release = (over = {}) => ({ key: 'r-one', date: '2026-11-08', revision: 1, importance: 'important', title: 'Smarter capture', summary: 'Write tasks the way you speak.',
  items: [item(), item({ type: 'improved', title: 'Faster sync', body: 'Changes appear sooner.', feature: null, can_try: false, is_new: false }), item({ type: 'fixed', title: 'Dates near midnight', body: 'Fixed.', feature: null, can_try: false, is_new: false })], ...over })
const arabic = release({ title: 'التقاط أذكى', summary: 'اكتب مهامك كما تتحدث.', items: [item({ title: 'الالتقاط السريع', body: 'اكتب جملة فيقرأ LifeOS الوقت.' }), item({ type: 'fixed', title: 'التواريخ قرب منتصف الليل', body: 'تم الإصلاح.', feature: null, can_try: false, is_new: false })] })

/** The server is stubbed for the discovery endpoints only; the rest of the app is the real one. */
async function stub(page: import('@playwright/test').Page, announcement: unknown, history: unknown[] = []) {
  const recorded: string[] = []
  await page.route('**/api/discovery/bootstrap**', route => route.fulfill({ json: { data: { announcement, update_required: false, counts: { unseen_updates: announcement ? 1 : 0 }, preferences: { hints_enabled: true } } } }))
  await page.route('**/api/discovery/releases**', route => route.fulfill({ json: { data: history } }))
  await page.route('**/api/discovery/states/**', route => { recorded.push(`${route.request().url().split('/states/')[1]} ${JSON.parse(route.request().postData() ?? '{}').action}`); return route.fulfill({ json: { data: {} } }) })
  await page.route('**/api/discovery/features/**/try**', route => route.fulfill({ json: { data: { available: true, reason: null, route: '/tasks', tour: null } } }))
  return recorded
}

for (const language of ['en', 'ar'] as const) {
  test(`the announcement is shown once, is accessible, and "Got it" ends it (${language})`, async ({ page, setLanguage }) => {
    await setLanguage(language)
    const recorded = await stub(page, language === 'ar' ? arabic : release())
    await page.goto('/')
    const dialog = page.getByRole('dialog', { name: language === 'ar' ? 'التقاط أذكى' : 'Smarter capture' })
    await expect(dialog).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr')
    await expect.poll(() => recorded).toContain('release/r-one seen')

    // The footer is reachable without scrolling the page: it stays inside the visible screen.
    const got = dialog.getByRole('button', { name: language === 'ar' ? 'حسنًا' : 'Got it' })
    // The dialog slides in; the footer must END inside the screen, so measure once the entrance animation has finished.
    await dialog.evaluate(d => Promise.all(d.getAnimations({ subtree: true }).map(a => a.finished.catch(() => undefined))))
    const size = page.viewportSize()!
    await expect.poll(async () => { const box = await got.boundingBox(); return box!.y + box!.height }).toBeLessThanOrEqual(size.height)

    expect(await a11yViolations(page, 'dialog[open]')).toEqual([])

    await got.click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => recorded).toContain('release/r-one dismissed')
  })
}

test('"Later" postpones, and "Try now" goes to the page the server names', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const recorded = await stub(page, release())
  await page.goto('/')
  const dialog = page.getByRole('dialog', { name: 'Smarter capture' })
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  await dialog.getByRole('button', { name: 'Try now' }).click()
  await expect(page).toHaveURL(/\/tasks$/)
  await expect(dialog).toBeHidden()
  await expect.poll(() => recorded).toContain('release/r-one dismissed')

  const later = await stub(page, release({ key: 'r-two' }))
  await page.evaluate(() => sessionStorage.clear())
  await page.goto('/')
  const second = page.getByRole('dialog', { name: 'Smarter capture' })
  await expect(second).toBeVisible({ timeout: 20_000 })
  await second.getByRole('button', { name: 'Later' }).click()
  await expect.poll(() => later).toContain('release/r-two snoozed')
})

test('nothing appears when there is no announcement', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await stub(page, null)
  await page.goto('/')
  await expect(page.locator('main')).toBeVisible()
  await page.waitForTimeout(5000)
  await expect(page.locator('dialog[open]')).toHaveCount(0)
})

test('the update history lists releases and has no accessibility violations', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await stub(page, null, [{ ...release(), seen: false, helpful: null }, { ...release({ key: 'r-old', title: 'Older update', date: '2026-10-01', importance: 'normal' }), seen: true, helpful: true }])
  await page.goto('/updates')
  await expect(page.getByRole('heading', { name: 'What’s new', level: 1 })).toBeVisible()
  await expect(page.getByRole('article')).toHaveCount(2)
  await expect(page.getByRole('heading', { name: 'Older update' })).toBeVisible()
  expect(await a11yViolations(page)).toEqual([])
})
