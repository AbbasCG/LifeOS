import { test, expect, noHorizontalOverflow, pick, field } from './fixtures'
import { a11yViolations, settle } from './axe'
import type { Page, TestInfo } from '@playwright/test'

/**
 * First-run setup and the simple navigation, for real: brand-new accounts registered through the form in a Tokyo browser, and the demo
 * account (an account from before these settings: setup done, full navigation), which must see no change at all.
 */
const ZONE = 'Asia/Tokyo', PASSWORD = 'a-long-e2e-password'
type Settings = Record<string, unknown>
async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p, { method: m, credentials: 'include', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-XSRF-TOKEN': token }, body: b === null ? undefined : JSON.stringify(b) })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, path, body ?? null] as const)
}
const settingsOf = async (page: Page) => (await call(page, 'GET', '/api/settings')).body as Settings

/** Signs up through the form in English, like a new person would; the app then lands on Today with the setup open. */
async function register(page: Page, testInfo: TestInfo, tag: string) {
  const email = `e2e-onboarding-${tag}-${testInfo.project.name}-${Date.now()}@lifeos.local`
  await page.addInitScript(() => { if (!localStorage.getItem('lifeos-language')) localStorage.setItem('lifeos-language', 'en') })
  await page.goto('/register')
  await page.getByLabel('Name').fill('E2E Newcomer')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByLabel('Confirm password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL(url => url.pathname === '/')
  return email
}
/** The throwaway account is deleted at the end (the e2e database is thrown away after the run anyway). */
async function removeAccount(page: Page) {
  if (!page.url().startsWith('http')) return
  const deleted = await call(page, 'DELETE', '/api/account', { password: PASSWORD }).catch(() => null)
  expect.soft(deleted?.status, 'throwaway account deleted').toBe(200)
}
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 900
/** The sidebar, opened from the menu button on a phone. */
async function sidebar(page: Page) {
  if (isPhone(page)) await page.getByRole('button', { name: /Toggle menu|تبديل القائمة/ }).first().click()
  const aside = page.locator('aside.sidebar')
  await expect(aside.getByRole('link', { name: /^(Today|اليوم)$/ })).toBeVisible()
  return aside
}
const navLinks = (aside: import('@playwright/test').Locator) => aside.getByRole('navigation').getByRole('link')

test.describe('a brand-new account', () => {
  test.use({ storageState: { cookies: [], origins: [] }, timezoneId: ZONE })

  test('walks the three steps, saves them in one request, lands on Today, and the simple navigation opens up on request', async ({ page, guard }, testInfo) => {
    guard.allowConsole(/status of 401/)   // the app asks who is signed in before there is anyone
    try {
      await register(page, testInfo, 'walk')
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('heading', { name: 'Your basics' })).toBeFocused()
      await expect(dialog.getByText('Step 1 of 3')).toBeVisible()
      // The zone is the browser's (from signup), and the local time there is shown to confirm it.
      await expect(dialog.getByRole('combobox', { name: 'Time zone' })).toHaveValue(ZONE)
      await expect(dialog.getByText('Your local time there:')).toBeVisible()
      await expect(dialog.getByRole('combobox', { name: 'Language' })).toHaveValue('en')

      await dialog.getByRole('button', { name: 'Next' }).click()
      await expect(dialog.getByRole('heading', { name: 'Your work week' })).toBeFocused()
      const days = dialog.getByRole('group', { name: 'Working days' }).getByRole('checkbox')
      await expect(days).toHaveCount(7)
      await dialog.getByRole('combobox', { name: 'Week starts on' }).selectOption({ label: 'Saturday' })
      // The days follow the chosen week: Saturday first, Sunday to Thursday selected.
      await expect(dialog.getByRole('group', { name: 'Working days' }).locator('label').first()).toHaveText('Sat')
      await expect(dialog.getByRole('checkbox', { name: 'Sun' })).toBeChecked()
      await expect(dialog.getByRole('checkbox', { name: 'Fri' })).not.toBeChecked()
      await dialog.getByRole('checkbox', { name: 'Thu' }).uncheck()
      await dialog.getByRole('checkbox', { name: 'Sat' }).check()
      await pick(page, field(dialog, 'Work ends'), '16:30')

      await dialog.getByRole('button', { name: 'Next' }).click()
      await expect(dialog.getByRole('heading', { name: 'Optional extras' })).toBeFocused()
      await dialog.getByRole('checkbox', { name: 'Show Hijri dates beside the Gregorian ones' }).check()
      await expect(dialog.getByRole('link', { name: 'Finish and connect a calendar in Settings' })).toHaveAttribute('href', '/settings/integrations')
      // Back keeps what was chosen.
      await dialog.getByRole('button', { name: 'Back' }).click()
      await expect(dialog.getByRole('heading', { name: 'Your work week' })).toBeFocused()
      await expect(dialog.getByRole('checkbox', { name: 'Thu' })).not.toBeChecked()
      await dialog.getByRole('button', { name: 'Next' }).click()

      const puts: string[] = []
      page.on('request', r => { if (r.method() === 'PUT' && r.url().endsWith('/api/settings')) puts.push(r.postData() ?? '') })
      const saved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/api/settings'))
      await dialog.getByRole('button', { name: 'Finish' }).click()
      expect((await saved).status()).toBe(200)
      await expect(page.getByText('Welcome to LifeOS. You are all set.')).toBeVisible()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      expect(new URL(page.url()).pathname).toBe('/')
      expect(puts).toHaveLength(1)
      expect(JSON.parse(puts[0])).toMatchObject({ onboarding: 'done', week_start: 6, timezone: ZONE })

      const settings = await settingsOf(page)
      expect(settings).toMatchObject({ onboarding: 'done', ui_mode: 'simple', timezone: ZONE, language: 'en', week_start: 6, work_days: [0, 1, 2, 3, 6], work_start: '09:00', work_end: '16:30', calendar_system: 'hijri', prayer_enabled: false })

      // A reload does not show the setup again.
      const loaded = page.waitForResponse(r => r.request().method() === 'GET' && r.url().endsWith('/api/settings'))
      await page.reload()
      await loaded
      let aside = await sidebar(page)
      await expect(page.getByRole('dialog')).toHaveCount(0)

      // The simple navigation: four places and «More», which opens the rest in place.
      await expect(navLinks(aside)).toHaveText(['Today', 'Tasks', 'Calendar', 'Focus'])
      const more = aside.getByRole('button', { name: 'More' })
      await expect(more).toHaveAttribute('aria-expanded', 'false')
      await more.click()
      await expect(more).toHaveAttribute('aria-expanded', 'true')
      await expect(aside.getByRole('link', { name: 'Weekly review' })).toBeVisible()
      await more.click()
      await expect(aside.getByRole('link', { name: 'Weekly review' })).toBeHidden()

      const full = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/api/settings'))
      await aside.getByRole('button', { name: 'Show all sections' }).click()
      expect((await full).status()).toBe(200)
      expect((await settingsOf(page)).ui_mode).toBe('full')
      await page.reload()
      aside = await sidebar(page)
      await expect(aside.getByRole('link', { name: 'Weekly review' })).toBeVisible()
      await expect(aside.getByRole('button', { name: 'More' })).toHaveCount(0)
      await expect(aside.getByRole('button', { name: 'Show all sections' })).toHaveCount(0)
      expect(await navLinks(aside).count()).toBe(16)
    } finally {
      await removeAccount(page)
    }
  })

  test('Escape asks in the page; «Skip setup» keeps the defaults and marks the setup done', async ({ page, guard }, testInfo) => {
    guard.allowConsole(/status of 401/)
    try {
      await register(page, testInfo, 'skip')
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('heading', { name: 'Your basics' })).toBeFocused()
      await dialog.getByText('Step 1 of 3').click()
      await page.keyboard.press('Escape')
      await expect(dialog.getByText('Skip the setup?')).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Keep setting up' })).toBeFocused()
      await page.keyboard.press('Enter')   // keep setting up
      await expect(dialog.getByRole('heading', { name: 'Your basics' })).toBeFocused()
      expect((await settingsOf(page)).onboarding).toBe('pending')
      await page.keyboard.press('Escape')
      await dialog.getByRole('button', { name: 'Skip setup' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      expect(await settingsOf(page)).toMatchObject({ onboarding: 'done', ui_mode: 'simple', timezone: ZONE, language: 'en', week_start: 1, calendar_system: 'gregorian', prayer_enabled: false })
      await page.reload()
      await sidebar(page)
      await expect(page.getByRole('dialog')).toHaveCount(0)
    } finally {
      await removeAccount(page)
    }
  })

  test('Arabic at 320 px: every step fits without sideways scrolling and passes axe', async ({ page, guard }, testInfo) => {
    guard.allowConsole(/status of 401/)
    await page.setViewportSize({ width: 320, height: 720 })
    try {
      await register(page, testInfo, 'ar320')
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('heading', { name: 'Your basics' })).toBeFocused()
      // The language switches at once.
      await dialog.getByRole('combobox', { name: 'Language' }).selectOption('ar')
      await expect(dialog.getByRole('heading', { name: 'الأساسيات' })).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
      for (const [title, next] of [['الأساسيات', 'التالي'], ['أسبوع عملك', 'التالي'], ['إضافات اختيارية', null]] as const) {
        await expect(dialog.getByRole('heading', { name: title })).toBeFocused()
        await settle(page)   // the dialog's entrance has finished, so its box is where it stays
        await noHorizontalOverflow(page)
        const box = (await dialog.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(320)
        expect(await dialog.evaluate(el => el.scrollWidth - el.clientWidth), `${title}: no sideways scroll inside the dialog`).toBeLessThanOrEqual(0)
        expect(await a11yViolations(page, '.os-dialog'), title).toEqual([])
        if (next) await dialog.getByRole('button', { name: next }).click()
      }
      // The confirmation is checked too.
      await page.keyboard.press('Escape')
      await expect(dialog.getByText('تخطي الإعداد؟')).toBeVisible()
      expect(await a11yViolations(page, '.os-dialog'), 'confirm').toEqual([])
      await dialog.getByRole('button', { name: 'تخطي الإعداد' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      expect(await settingsOf(page)).toMatchObject({ onboarding: 'done', language: 'ar' })
    } finally {
      await removeAccount(page)
    }
  })
})

test('the demo account (set up before these settings) sees no setup and the full navigation', async ({ page }) => {
  const loaded = page.waitForResponse(r => r.request().method() === 'GET' && r.url().endsWith('/api/settings'))
  await page.goto('/')
  const settings = await (await loaded).json() as Settings
  expect(settings).toMatchObject({ onboarding: 'done', ui_mode: 'full' })
  const aside = await sidebar(page)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(aside.getByRole('button', { name: /^(More|المزيد)$/ })).toHaveCount(0)
  await expect(aside.getByRole('button', { name: /Show all sections|إظهار كل الأقسام/ })).toHaveCount(0)
  await expect(aside.getByRole('navigation')).toHaveCount(4)
  expect(await navLinks(aside).count()).toBeGreaterThanOrEqual(16)
  await expect(aside.locator('[data-tour="nav-review"]')).toBeVisible()
})
