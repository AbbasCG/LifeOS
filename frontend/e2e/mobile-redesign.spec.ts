import { test, expect, noHorizontalOverflow } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * Mobile-first redesign (V53): iPhone 13 (390x844) is the reference, 375 and 430 must behave the same, and the desktop keeps working.
 * Real Chromium with touch emulation. NOT covered here (needs a real device): the iOS Safari keyboard and its zoom-on-focus behaviour;
 * the 16px font size that prevents that zoom is asserted instead.
 */
async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, path, body] as const)
}
const stamp = () => `E2E mobile ${Date.now()}${Math.floor(Math.random() * 1000)}`
async function findTask(page: Page, title: string) {
  const r = await call(page, 'GET', `/api/tasks?search=${encodeURIComponent(title)}&per_page=5`)
  return (r.body?.data as { id: number; title: string; priority: string; due_at: string | null; estimated_minutes: number | null; project_id: number | null }[] ?? []).find(t => t.title === title)
}
async function removeTask(page: Page, title: string) { const t = await findTask(page, title); if (t) await call(page, 'DELETE', `/api/tasks/${t.id}`) }
const dayIn = (at: string | Date, zone: string) => new Date(at).toLocaleDateString('en-CA', { timeZone: zone })

/** What a sheet must satisfy on a phone: inside the screen, inputs >= 16px, every control >= 44px, nothing widens the page. */
async function expectPhoneSheet(page: Page) {
  const sheet = page.locator('dialog[open] .sheet-inner')
  await expect(sheet).toBeVisible()
  // Measure after the slide-up animation has finished.
  await sheet.evaluate(e => Promise.all(e.getAnimations({ subtree: true }).map(a => a.finished.catch(() => undefined))))
  await noHorizontalOverflow(page)
  const facts = await page.evaluate(() => {
    const inner = document.querySelector('dialog[open] .sheet-inner')!.getBoundingClientRect()
    const dialog = document.querySelector('dialog[open]')!
    const visible = (e: Element) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden' }
    const fields = [...dialog.querySelectorAll<HTMLElement>('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=color]), select, textarea')].filter(visible)
    const smallText = fields.filter(f => parseFloat(getComputedStyle(f).fontSize) < 16).map(f => f.getAttribute('aria-label') || f.getAttribute('name') || f.tagName)
    const controls = [...dialog.querySelectorAll<HTMLElement>('button, summary, input[type=search], input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=color]), select')].filter(visible)
    const tooSmall = controls.filter(c => { const b = c.getBoundingClientRect(); return b.height < 43.5 || b.width < 43.5 }).map(c => `${(c.getAttribute('aria-label') || c.textContent || c.tagName).trim().slice(0, 30)} ${Math.round(c.getBoundingClientRect().width)}x${Math.round(c.getBoundingClientRect().height)}`)
    return { top: inner.top, bottom: inner.bottom, left: inner.left, right: inner.right, vw: innerWidth, vh: innerHeight, smallText, tooSmall, scale: window.visualViewport?.scale ?? 1 }
  })
  expect(facts.top, 'sheet top inside the screen').toBeGreaterThanOrEqual(0)
  expect(facts.bottom, 'sheet bottom inside the screen').toBeLessThanOrEqual(facts.vh + 0.5)
  expect(facts.left).toBeGreaterThanOrEqual(-0.5); expect(facts.right).toBeLessThanOrEqual(facts.vw + 0.5)
  expect(facts.smallText, 'inputs under 16px zoom the page on iOS').toEqual([])
  expect(facts.tooSmall, 'touch targets under 44px').toEqual([])
  expect(facts.scale).toBe(1)
  return facts
}

const sizes = [['iPhone SE-class 375', 375, 812], ['iPhone 13 390', 390, 844], ['iPhone Pro Max-class 430', 430, 932]] as const
for (const [name, width, height] of sizes) {
  test.describe(`phone ${name}`, () => {
    test.use({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 })
    // eslint-disable-next-line no-empty-pattern
    test.beforeEach(async ({}, info) => { test.skip(info.project.name !== 'desktop', 'one emulated phone per size is enough') })

    test('Quick add: fits the screen, big targets, Add is always reachable, two taps add a task', async ({ page, setLanguage }) => {
      await setLanguage('en')
      await page.goto('/'); await page.waitForLoadState('networkidle')
      await page.getByRole('button', { name: 'Quick add' }).first().tap()
      await expectPhoneSheet(page)
      const add = page.getByRole('button', { name: 'Add task', exact: true })
      await expect(add).toBeInViewport({ ratio: 1 })
      // The Add button is a full-width target; the date and priority choices are direct buttons with icons.
      const box = (await add.boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(52); expect(box.width).toBeGreaterThan(width * 0.8)
      for (const g of ['When', 'Priority']) await expect(page.getByRole('radiogroup', { name: g }).locator('svg').first()).toBeVisible()
      const title = stamp()
      try {
        await page.locator('dialog[open] [data-autofocus]').fill(title)
        await add.tap()
        await expect.poll(async () => (await findTask(page, title))?.priority).toBe('medium')
      } finally { await removeTask(page, title) }
    })

    test('Quick add: "Tomorrow" and "Urgent" are one tap each and are saved', async ({ page, setLanguage }) => {
      await setLanguage('en')
      await page.goto('/')
      const zone = (await call(page, 'GET', '/api/settings')).body.timezone as string
      await page.getByRole('button', { name: 'Quick add' }).first().tap()
      const title = stamp()
      try {
        await page.locator('dialog[open] [data-autofocus]').fill(title)
        await page.getByRole('radio', { name: 'Tomorrow' }).tap()
        await page.getByRole('radio', { name: 'Urgent' }).tap()
        await expect(page.getByRole('radio', { name: 'Tomorrow' })).toHaveAttribute('aria-checked', 'true')
        await page.getByRole('button', { name: 'Add task', exact: true }).tap()
        await expect.poll(async () => (await findTask(page, title))?.priority).toBe('urgent')
        expect(dayIn((await findTask(page, title))!.due_at!, zone)).toBe(dayIn(new Date(Date.now() + 86_400_000), zone))
      } finally { await removeTask(page, title) }
    })

    test('Quick add: a day picked on the calendar is saved', async ({ page, setLanguage }) => {
      await setLanguage('en')
      await page.goto('/')
      const zone = (await call(page, 'GET', '/api/settings')).body.timezone as string
      await page.getByRole('button', { name: 'Quick add' }).first().tap()
      const title = stamp(), day = dayIn(new Date(Date.now() + 9 * 86_400_000), zone)
      try {
        await page.locator('dialog[open] [data-autofocus]').fill(title)
        await page.locator('.qa-pick .dtp-trigger').tap()
        const picker = page.locator('.dtp-dialog[open]')
        await expect(picker).toBeVisible()
        const box = picker.getByRole('textbox', { name: 'Date' }); await box.fill(day); await box.press('Enter')
        await picker.getByRole('button', { name: 'Done' }).tap()
        await expect(page.locator('.qa-pick')).toHaveClass(/is-set/)
        await page.getByRole('button', { name: 'Add task', exact: true }).tap()
        await expect.poll(async () => (await findTask(page, title))?.due_at ? dayIn((await findTask(page, title))!.due_at!, zone) : null).toBe(day)
      } finally { await removeTask(page, title) }
    })

    test('Details form: choices not drop-downs, Save never scrolls away, the body scrolls inside the sheet', async ({ page, setLanguage }) => {
      await setLanguage('en')
      await page.goto('/')
      const projects = (await call(page, 'GET', '/api/projects?per_page=5')).body?.data as { id: number; title: string }[]
      await page.getByRole('button', { name: 'Quick add' }).first().tap()
      const title = stamp()
      await page.locator('dialog[open] [data-autofocus]').fill(title)
      await page.getByRole('button', { name: /More details/ }).tap()
      await expectPhoneSheet(page)
      const dialog = page.locator('dialog[open]').first()
      await expect(dialog.locator('select')).toHaveCount(0)
      const save = dialog.getByRole('button', { name: 'Save', exact: true })
      await expect(save).toBeInViewport({ ratio: 1 })
      // The long form scrolls inside the sheet; the footer (Save) stays put.
      const body = dialog.locator('.sheet-body')
      expect(await body.evaluate(e => e.scrollHeight > e.clientHeight)).toBe(true)
      const before = (await save.boundingBox())!.y
      await body.evaluate(e => { e.scrollTop = e.scrollHeight })
      expect(Math.abs((await save.boundingBox())!.y - before)).toBeLessThan(1)
      await body.evaluate(e => { e.scrollTop = 0 })
      try {
        await dialog.getByRole('radio', { name: 'High', exact: true }).tap()
        await dialog.getByRole('radio', { name: '1h', exact: true }).tap()
        if (projects?.length) {
          await dialog.getByRole('button', { name: /^Project:/ }).tap()
          const list = page.getByRole('dialog', { name: 'Project' })
          await expect(list).toBeVisible()
          await list.getByRole('radio', { name: projects[0].title, exact: true }).tap()
          await expect(page.getByRole('button', { name: `Project: ${projects[0].title}` })).toBeVisible()
        }
        await save.tap()
        await expect.poll(async () => (await findTask(page, title))?.priority).toBe('high')
        const saved = (await findTask(page, title))!
        expect(saved.estimated_minutes).toBe(60)
        if (projects?.length) expect(saved.project_id).toBe(projects[0].id)
      } finally { await removeTask(page, title) }
    })

    test('with the keyboard up (a much shorter screen) Save and Add stay on screen', async ({ page, setLanguage }) => {
      await setLanguage('en')
      await page.goto('/')
      await page.getByRole('button', { name: 'Quick add' }).first().tap()
      await page.locator('dialog[open] [data-autofocus]').fill('Keyboard')
      await page.setViewportSize({ width, height: 440 })    // what is left above an iPhone keyboard
      await expect(page.getByRole('button', { name: 'Add task', exact: true })).toBeInViewport({ ratio: 1 })
      await page.getByRole('button', { name: /More details/ }).evaluate(b => (b as HTMLElement).click())
      await expect(page.locator('dialog[open]').first().getByRole('button', { name: 'Save', exact: true })).toBeInViewport({ ratio: 1 })
      await noHorizontalOverflow(page)
    })

    test('Arabic right-to-left and dark mode: nothing overflows and the choices read right to left', async ({ page, setLanguage }) => {
      await page.emulateMedia({ colorScheme: 'dark' })
      await setLanguage('ar')
      await page.goto('/')
      await page.getByRole('button', { name: 'إضافة سريعة' }).first().tap()
      await expectPhoneSheet(page)
      const when = page.getByRole('radiogroup', { name: 'متى' }).getByRole('radio')
      const xs = await when.evaluateAll(els => els.map(e => e.getBoundingClientRect().x))
      expect(xs[0]).toBeGreaterThan(xs[xs.length - 1])        // first choice sits at the right edge
      await page.locator('dialog[open] [data-autofocus]').fill('اختبار')
      await page.getByRole('button', { name: /تفاصيل أكثر/ }).tap()
      await expectPhoneSheet(page)
      await expect(page.locator('dialog[open]').first().getByRole('button', { name: 'حفظ', exact: true })).toBeInViewport({ ratio: 1 })
    })

    test('Connected accounts: compact, icon-first, details behind (i) and sheets', async ({ page, setLanguage }) => {
      await setLanguage('en')
      await page.goto('/settings/integrations'); await page.waitForLoadState('networkidle')
      await expect(page.getByRole('heading', { name: 'Connected accounts', exact: true })).toBeVisible()
      await noHorizontalOverflow(page)
      // It used to be ~4400px tall on a phone; compact rows keep it to a couple of screens.
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(height * 3.2)
      const rows = page.locator('.hub-item')
      expect(await rows.count()).toBeGreaterThanOrEqual(5)
      for (const h of await rows.evaluateAll(els => els.map(e => e.getBoundingClientRect().height))) expect(h).toBeLessThanOrEqual(100)
      // The long explanations are not on the page; they open on request.
      await expect(page.getByText(/creates, changes or deletes nothing there/)).toHaveCount(0)
      await page.getByRole('button', { name: 'About connections' }).tap()
      await expect(page.getByText(/creates, changes or deletes nothing there unless you allow it/)).toBeVisible()
      await expectPhoneSheet(page)
      await page.locator('dialog[open]').getByRole('button', { name: 'Close' }).tap()
      // A subscription link opens in a sheet with a 16px field.
      await page.getByRole('button', { name: /Add link/ }).tap()
      await expect(page.getByLabel('Calendar address (.ics or webcal)')).toBeVisible()
      await expectPhoneSheet(page)
    })
  })
}

test.describe('integrations loading and error states', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, info) => { test.skip(info.project.name !== 'desktop') })
  test('a slow server shows a skeleton; a failing one shows an alert, not a blank page', async ({ page, setLanguage, guard }) => {
    guard.allowConsole(/status of 500/)
    await setLanguage('en')
    await page.route('**/api/integrations', async route => { await new Promise(r => setTimeout(r, 700)); await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'The server had a problem.' }) }) })
    await page.goto('/settings/integrations')
    await expect(page.locator('.skeleton').first()).toBeVisible()
    await expect(page.getByRole('alert')).toContainText('server had a problem')
    await noHorizontalOverflow(page)
  })
})

test.describe('desktop keeps working', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, info) => { test.skip(info.project.name !== 'desktop') })
  test('Quick add is a centred card and the details form saves', async ({ page, setLanguage }) => {
    await setLanguage('en')
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/tasks')
    await page.getByRole('button', { name: 'Add task' }).first().click()
    const inner = page.locator('dialog[open] .sheet-inner')
    await expect(inner).toBeVisible()
    await inner.evaluate(e => Promise.all(e.getAnimations().map(a => a.finished.catch(() => undefined))))
    const box = (await inner.boundingBox())!
    expect(box.width).toBeLessThanOrEqual(560); expect(Math.abs(box.x + box.width / 2 - 720)).toBeLessThan(4)
    const title = stamp()
    try {
      await page.locator('dialog[open] [data-autofocus]').fill(title)
      await page.getByRole('button', { name: /More details/ }).click()
      const dialog = page.locator('dialog[open]').first()
      await dialog.getByRole('radio', { name: 'Urgent', exact: true }).click()
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await expect.poll(async () => (await findTask(page, title))?.priority).toBe('urgent')
    } finally { await removeTask(page, title) }
  })
})
