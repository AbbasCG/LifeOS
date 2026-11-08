import { test, expect } from './fixtures'
import { a11yViolations } from './axe'

const SECRET = 'e2e-secret-never-shown-again'
const google = {
  provider: 'google', name: { en: 'Google Calendar', ar: 'تقويم Google' }, docs_url: 'https://developers.google.com/calendar/api',
  scopes: [{ id: 'calendar.readonly', required: true, label: { en: 'Read', ar: 'قراءة' } }, { id: 'calendar.events', required: false, label: { en: 'Write', ar: 'كتابة' } }],
  configured: false, source: 'none', client_id: null, has_secret: false, redirect_uri: null, suggested_redirect_uri: 'https://app.lifeos.test/api/integrations/google/callback',
  rotated_at: null, connections_allowed: true, secret_unreadable: false, updated_at: null, updated_by: null,
}

/** The demo account is not an administrator: the user and the administrator endpoints are stubbed, the rest of the app is real. */
async function asAdmin(page: import('@playwright/test').Page) {
  const writes: { method: string; body: unknown }[] = []
  await page.route('**/api/user', async route => {
    const real = await route.fetch()
    await route.fulfill({ response: real, json: { ...(await real.json()), is_admin: true, two_factor_enabled: true } })
  })
  await page.route('**/api/admin/integrations/credentials', route => route.fulfill({ json: { data: [google] } }))
  await page.route('**/api/admin/integrations/credentials/google', route => { writes.push({ method: route.request().method(), body: JSON.parse(route.request().postData() ?? '{}') }); return route.fulfill({ json: { data: { ...google, configured: true, source: 'database', client_id: 'cid', has_secret: true } } }) })
  await page.route('**/api/admin/integrations/audit', route => route.fulfill({ json: { data: [] } }))
  return writes
}

for (const language of ['en', 'ar'] as const) {
  test(`the provider configuration is accessible, fits the screen and never keeps the secret (${language})`, async ({ page, setLanguage }) => {
    await setLanguage(language)
    const writes = await asAdmin(page)
    await page.goto('/settings/integrations')
    const heading = page.getByRole('heading', { level: 2, name: language === 'ar' ? 'إعداد المزودين' : 'Provider configuration' })
    await expect(heading).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr')
    expect(await a11yViolations(page)).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)

    await page.locator('[data-tour="integrations-admin-credentials"]').getByRole('button', { name: language === 'ar' ? /^إعداد/ : /^Set up/ }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('https://app.lifeos.test/api/integrations/google/callback')).toBeVisible()
    await dialog.locator('input[autocomplete="off"]').fill('client-1')
    await dialog.locator('input[type="password"]').fill(SECRET)
    expect(await a11yViolations(page)).toEqual([])
    await dialog.locator('form').evaluate(form => (form as HTMLFormElement).requestSubmit())
    await expect.poll(() => writes.length).toBe(1)
    expect(writes[0].method).toBe('PUT')
    await expect(dialog).toBeHidden()
    // The secret is nowhere in the page, its storage or its URL after it was sent.
    expect(await page.content()).not.toContain(SECRET)
    expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), location.href]))).not.toContain(SECRET)
  })
}
