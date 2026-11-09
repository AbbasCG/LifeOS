import { test, expect } from './fixtures'
import { a11yViolations } from './axe'

const provider = (over: Record<string, unknown> = {}) => ({
  provider: 'google', label: 'Google Calendar', category: 'calendars', implemented: true, configured: true, status: 'available', scopes: 'Read-only calendars',
  env_keys: [], redirect_uri: null, required_scopes: ['calendar.readonly'], accounts: [], ...over,
})
async function hub(page: import('@playwright/test').Page, providers: unknown[]) {
  await page.route('**/api/integrations', route => route.fulfill({ json: { providers, categories: [{ key: 'calendars', providers }], ai_connected_data: false } }))
  await page.route('**/api/calendar-write', route => route.fulfill({ json: { enabled: false, links: [] } }))
}

for (const language of ['en', 'ar'] as const) {
  test(`an ordinary person is asked for no keys and is told what to do (${language})`, async ({ page, setLanguage }) => {
    await setLanguage(language)
    await hub(page, [provider({ configured: false, status: 'needs_configuration' })])
    await page.goto('/settings/integrations')
    await page.getByRole('button', { name: language === 'ar' ? /عن Google Calendar/ : /About Google Calendar/ }).click()
    const sheet = page.getByRole('dialog')
    await expect(sheet).toContainText(language === 'ar' ? 'اطلب من مسؤول LifeOS' : 'Ask a LifeOS administrator')
    await expect(sheet).not.toContainText('GOOGLE_CLIENT')
    await expect(sheet.getByRole('textbox')).toHaveCount(0)
    expect(await a11yViolations(page)).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  })
}

test('every way the sign-in can end sends the person back with a reason, and leaves the address clean', async ({ page, setLanguage }) => {
  await setLanguage('en')
  // The message is made when the page opens, in the language this browser already uses (as for a person who changed it before).
  await page.addInitScript(() => localStorage.setItem('lifeos-language', 'en'))
  await hub(page, [provider()])
  const reasons: [string, RegExp][] = [
    ['state', /expired or was already used/], ['denied', /Access was not granted/], ['exchange', /could not complete the connection/],
    ['not_configured', /not set up on this server/], ['provider_disabled', /switched off by an administrator/],
  ]
  for (const [code, text] of reasons) {
    await page.goto(`/settings/integrations?error=${code}&provider=google`)
    await expect(page.getByText(text).first()).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => new URL(page.url()).search).toBe('')
  }
})

test('a connected account shows who it is and offers Reconnect when its access ended', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const account = { id: 7, provider: 'google', email: 'me@gmail.com', display_name: 'Me', status: 'revoked', last_synced_at: null, last_error: 'Google Calendar access was revoked or has expired.', events_count: 0, connected_at: null, collections: [], collections_managed: true, recent_runs: [] }
  await hub(page, [provider({ accounts: [account] })])
  await page.goto('/settings/integrations')
  await expect(page.getByText('me@gmail.com')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Access revoked')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible()
  expect(await a11yViolations(page)).toEqual([])
})
