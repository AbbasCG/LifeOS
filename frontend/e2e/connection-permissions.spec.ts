import { test, expect } from './fixtures'
import { a11yViolations } from './axe'

const calendarState = (over = {}) => ({ granted: ['read', 'sync'], effective: ['read', 'sync'], capabilities: ['read', 'sync', 'export', 'create', 'update', 'delete'], presets: ['read_only', 'read_create', 'read_create_update', 'full'],
  preset: 'read_only', legacy: false, blocked: {}, changed_at: null, ...over })
const account = (permissions: unknown) => ({ id: 7, provider: 'google', email: 'me@gmail.com', display_name: 'Me', status: 'active', last_synced_at: null, last_error: null, events_count: 0, connected_at: null,
  collections: [], collections_managed: true, recent_runs: [], permissions })

async function hub(page: import('@playwright/test').Page, permissions: unknown) {
  const puts: unknown[] = []
  const providers = [{ provider: 'google', label: 'Google Calendar', category: 'calendars', implemented: true, configured: true, status: 'available', scopes: 'Read-only calendars', env_keys: [], redirect_uri: null, required_scopes: ['calendar.readonly'],
    capabilities: ['read', 'sync', 'export', 'create', 'update', 'delete'], presets: ['read_only', 'read_create', 'read_create_update', 'full'], accounts: [account(permissions)] }]
  await page.route('**/api/integrations', route => route.fulfill({ json: { providers, categories: [{ key: 'calendars', providers }], ai_connected_data: false } }))
  await page.route('**/api/calendar-write', route => route.fulfill({ json: { enabled: false, links: [] } }))
  await page.route('**/api/integrations/accounts/7/permissions', route => { puts.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ json: { data: calendarState({ preset: 'read_create' }) } }) })
  return puts
}

for (const language of ['en', 'ar'] as const) {
  test(`choosing what LifeOS may do is accessible, asks separately about Delete and fits the screen (${language})`, async ({ page, setLanguage }) => {
    await setLanguage(language)
    const puts = await hub(page, calendarState())
    await page.goto('/settings/integrations')
    await page.getByRole('button', { name: language === 'ar' ? /تفاصيل me@gmail.com/ : /Details of me@gmail.com/ }).click()
    await page.getByRole('button', { name: language === 'ar' ? 'إدارة الصلاحيات' : 'Manage permissions' }).click()
    const dialog = page.getByRole('dialog', { name: language === 'ar' ? /صلاحيات/ : /Permissions for/ })
    await expect(dialog).toBeVisible()
    expect(await a11yViolations(page)).toEqual([])
    await dialog.getByRole('radio').nth(3).check()   // the last preset: full access
    await expect(dialog.getByRole('button', { name: language === 'ar' ? 'حفظ' : 'Save' })).toBeDisabled()
    await dialog.getByRole('checkbox').check()
    expect(await a11yViolations(page)).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    await dialog.getByRole('button', { name: language === 'ar' ? 'حفظ' : 'Save' }).click()
    await expect.poll(() => puts.length).toBe(1)
    expect(puts[0]).toEqual({ preset: 'full', confirm_delete: true })
    await expect(dialog).toBeHidden()
  })
}

test('Escape closes the permissions dialog without saving anything', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const puts = await hub(page, calendarState())
  await page.goto('/settings/integrations')
  await page.getByRole('button', { name: /Details of me@gmail.com/ }).click()
  await page.getByRole('button', { name: 'Manage permissions' }).click()
  const dialog = page.getByRole('dialog', { name: /Permissions for/ })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  expect(puts).toEqual([])
})
