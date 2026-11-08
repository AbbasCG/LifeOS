import { test, expect } from './fixtures'
import { a11yViolations } from './axe'

const HASH = 'c851cb5cbd8ad46c17daa3b8aa05faa93f5df9098d66ad1087a0428e15f2671b'
const texts = (en: string, ar: string, nl: string) => ({ en, ar, nl })
const release = {
  key: '2026-11-08-everyday-capture', date: '2026-11-08', revision: 1, importance: 'normal', title: texts('Quick Capture understands Arabic and Dutch', 'الالتقاط السريع يفهم العربية والهولندية', 'Snel vastleggen begrijpt Arabisch en Nederlands'), items: 2,
  registered: true, review_status: 'draft', deploy_status: 'live', deployed_sha: 'a'.repeat(40), content_hash: HASH, approved_hash: null, live_since: '2026-11-08T10:00:00+00:00', reviewed_at: null, visible: false,
  preview: {
    title: texts('Quick Capture understands Arabic and Dutch', 'الالتقاط السريع يفهم العربية والهولندية', 'Snel vastleggen begrijpt Arabisch en Nederlands'), summary: texts('Write tasks the way you speak.', 'اكتب مهامك كما تتحدث.', 'Schrijf taken zoals je praat.'), audiences: ['web', 'mobile'],
    items: [{ type: 'new', feature: 'quick-capture' }, { type: 'fixed', title: texts('Waiting changes are kept', 'التغييرات المنتظرة تبقى', 'Wachtende wijzigingen blijven'), body: texts('Nothing is lost.', 'لا يضيع شيء.', 'Er gaat niets verloren.') }],
    features: [{ id: 'quick-capture', category: 'tasks', name: texts('Quick Capture', 'الالتقاط السريع', 'Snel vastleggen'), description: texts('Type a phrase.', 'اكتب جملة.', 'Typ een zin.'), route: '/tasks', requires: [], tour: 'quick-capture-tour' }],
    tours: [{ id: 'quick-capture-tour', title: texts('Quick Capture', 'الالتقاط السريع', 'Snel vastleggen'), steps: [{ target: 'quick-add', title: texts('Add a task', 'أضف مهمة', 'Voeg een taak toe'), body: texts('Open Quick add.', 'افتح الإضافة السريعة.', 'Open Snel toevoegen.') }] }],
  },
}

/** The demo account is not an administrator: the user and the administrator endpoints are stubbed, the rest of the app is real. */
async function asAdmin(page: import('@playwright/test').Page, data = [release], activation = { enabled: true, status: 'confirmed', detail: 'ok' }) {
  const posts: { url: string; body: unknown }[] = []
  await page.route('**/api/user', async route => {
    const real = await route.fetch()
    await route.fulfill({ response: real, json: { ...(await real.json()), is_admin: true, two_factor_enabled: true } })
  })
  await page.route('**/api/admin/discovery/releases', route => route.fulfill({ json: { data, activation } }))
  await page.route('**/api/admin/discovery/stats', route => route.fulfill({ json: { data: { accounts: 12, releases: [{ key: release.key, seen: 7, dismissed: 3, snoozed: 1, helpful: 2, unhelpful: 1,
    features: [{ id: 'quick-capture', tried: 5, tour: { id: 'quick-capture-tour', version: 1, started: 4, completed: 3, skipped: 1 }, hints: [] }] }] } } }))
  await page.route('**/api/admin/discovery/releases/*/approve', route => { posts.push({ url: route.request().url(), body: JSON.parse(route.request().postData() ?? '{}') }); return route.fulfill({ json: { data: { key: release.key, review_status: 'approved', deploy_status: 'live', visible: true } } }) })
  await page.route('**/api/discovery/bootstrap**', route => route.fulfill({ json: { data: { announcement: null, update_required: false, counts: { unseen_updates: 0 }, preferences: { hints_enabled: true } } } }))
  await page.route('**/api/discovery/guide**', route => route.fulfill({ json: { data: { new: [], hints: [] } } }))
  return posts
}

for (const language of ['en', 'ar'] as const) {
  test(`the approval screen shows status and the exact text, is accessible and fits the screen (${language})`, async ({ page, setLanguage }) => {
    await setLanguage(language)
    await asAdmin(page)
    await page.goto('/admin/releases')
    await expect(page.getByRole('heading', { level: 2, name: /Quick Capture understands Arabic and Dutch/ })).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr')
    await page.locator('details.ra-preview summary').click()
    await page.locator('.ra-langs').getByRole('button', { name: 'العربية' }).click()
    await expect(page.locator('.ra-text[lang="ar"]')).toHaveAttribute('dir', 'rtl')
    await expect(page.locator('.ra-text')).toContainText('اكتب مهامك كما تتحدث.')
    // How people received it: counts, in the page language.
    await expect(page.locator('.ra-reception')).toContainText(language === 'ar' ? '7 من 12 حسابًا' : '7 of 12 accounts')
    expect(await a11yViolations(page)).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  })
}

test('approving needs the "I read it" box, sends the fingerprint, and the dialog is accessible', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const posts = await asAdmin(page)
  await page.goto('/admin/releases')
  await page.getByRole('button', { name: 'Approve', exact: true }).first().click({ timeout: 20_000 })
  const dialog = page.getByRole('dialog', { name: 'Approve this update?' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(HASH)
  const go = dialog.getByRole('button', { name: 'Approve', exact: true })
  await expect(go).toBeDisabled()
  expect(await a11yViolations(page, 'dialog[open]')).toEqual([])
  await dialog.getByRole('checkbox').check()
  await expect(go).toBeEnabled()
  await go.click()
  await expect.poll(() => posts.length).toBe(1)
  expect(posts[0].url).toContain('/api/admin/discovery/releases/2026-11-08-everyday-capture/approve')
  expect(posts[0].body).toEqual({ content_hash: HASH })
})

test('the menu offers the screen to administrators only', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const openMenu = async () => { if ((page.viewportSize()?.width ?? 1440) <= 1100) await page.getByRole('button', { name: /menu/i }).first().click() }
  // Not an administrator (the demo account): no entry, and the page itself says so without asking for anything.
  await page.route('**/api/discovery/bootstrap**', route => route.fulfill({ json: { data: { announcement: null, update_required: false, counts: { unseen_updates: 0 }, preferences: { hints_enabled: true } } } }))
  await page.goto('/')
  await page.locator('#main').waitFor({ timeout: 20_000 })
  await openMenu()
  await expect(page.locator('[data-tour="nav-discover"]')).toBeAttached()
  await expect(page.locator('[data-tour="nav-admin-releases"]')).toHaveCount(0)
  await page.goto('/admin/releases')
  await expect(page.getByText('Administrators only')).toBeVisible()
})

test('administrators find the entry in the menu and it opens the screen', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await asAdmin(page)
  await page.goto('/')
  await page.locator('#main').waitFor({ timeout: 20_000 })
  if ((page.viewportSize()?.width ?? 1440) <= 1100) await page.getByRole('button', { name: /menu/i }).first().click()
  await page.locator('[data-tour="nav-admin-releases"]').click()
  await expect(page).toHaveURL(/\/admin\/releases$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Approve updates' })).toBeVisible()
})
