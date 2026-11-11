import { test, expect } from './fixtures'
import { a11yViolations } from './axe'

const sync = (over = {}) => ({ direction: 'inbound', effective_direction: 'inbound', effective_reason: null, available_directions: ['inbound', 'outbound', 'two_way', 'manual'], conflict_policy: 'ask', paused: false,
  paused_at: null, copies: 3, copies_pending: 1, open_conflicts: 1, last_outbound: null, ...over })
const account = (s: unknown) => ({ id: 7, provider: 'google', email: 'me@gmail.com', display_name: 'Me', status: 'active', last_synced_at: null, last_error: null, events_count: 0, connected_at: null,
  collections: [], collections_managed: true, recent_runs: [], sync: s })

async function hub(page: import('@playwright/test').Page) {
  const calls: { url: string; body: unknown }[] = []
  const providers = [{ provider: 'google', label: 'Google Calendar', category: 'calendars', implemented: true, configured: true, status: 'available', scopes: 'Read-only calendars', env_keys: [], redirect_uri: null,
    required_scopes: ['calendar.readonly'], capabilities: ['read', 'sync'], presets: ['read_only'], accounts: [account(sync())] }]
  await page.route('**/api/integrations', route => route.fulfill({ json: { providers, categories: [{ key: 'calendars', providers }], ai_connected_data: false } }))
  await page.route('**/api/calendar-write', route => route.fulfill({ json: { enabled: false, links: [] } }))
  await page.route('**/api/integrations/accounts/7/sync-conflicts', route => route.fulfill({ json: { data: [{ id: 5, account_id: 7, status: 'open', resolution: null, title: 'Team lunch', starts_at: '2027-03-23T09:00:00Z', ends_at: null, detected_at: null }] } }))
  await page.route('**/api/integrations/accounts/7/sync-settings', route => { calls.push({ url: route.request().url(), body: JSON.parse(route.request().postData() ?? '{}') }); return route.fulfill({ json: { data: sync({ direction: 'two_way' }) } }) })
  return calls
}

for (const language of ['en', 'ar'] as const) {
  test(`sync settings are accessible, ask about conflicts, and fit the screen (${language})`, async ({ page, setLanguage }) => {
    await setLanguage(language)
    const calls = await hub(page)
    await page.goto('/settings/integrations')
    await page.getByRole('button', { name: language === 'ar' ? /تفاصيل me@gmail.com/ : /Details of me@gmail.com/ }).click()
    await page.getByRole('button', { name: language === 'ar' ? /كيف تتم المزامنة/ : /How it syncs/ }).click()
    await expect(page.getByText('Team lunch')).toBeVisible({ timeout: 20_000 })
    expect(await a11yViolations(page)).toEqual([])
    await page.getByRole('button', { name: language === 'ar' ? 'إعدادات المزامنة' : 'Sync settings' }).click()
    const dialog = page.getByRole('dialog', { name: language === 'ar' ? /إعدادات مزامنة/ : /Sync settings for/ })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('radio').nth(2).check()   // both ways
    await expect(dialog.getByRole('radio')).toHaveCount(8)   // four directions and four conflict choices
    expect(await a11yViolations(page)).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    await dialog.getByRole('button', { name: language === 'ar' ? 'حفظ' : 'Save' }).click()
    await expect.poll(() => calls.length).toBe(1)
    expect(calls[0].body).toEqual({ direction: 'two_way', conflict_policy: 'ask' })
    await expect(dialog).toBeHidden()
  })
}

test('Escape closes the sync dialog without saving', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const calls = await hub(page)
  await page.goto('/settings/integrations')
  await page.getByRole('button', { name: /Details of me@gmail.com/ }).click()
  await page.getByRole('button', { name: /How it syncs/ }).click()
  await page.getByRole('button', { name: 'Sync settings' }).click()
  const dialog = page.getByRole('dialog', { name: /Sync settings for/ })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  expect(calls).toEqual([])
})
