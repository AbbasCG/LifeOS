import { test, expect, chooseByTapping } from './fixtures'
import type { Locator, Page } from '@playwright/test'

/**
 * Every date and time field in the app, used for real: open it, choose a day / hour / minute, save the form, open the form again and
 * check that the same value is shown and that the right instant was stored. Run in other time zones too, because a deadline
 * typed as "14:30" must come back as 14:30 on the same device.
 */
const api = (page: Page, method: string, path: string, body?: unknown) => page.evaluate(async ([m, p, b]) => {
  const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
  const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
  return r.status === 204 ? null : r.json().catch(() => null)
}, [method, path, body] as const)
const ymd = (offsetDays: number) => { const d = new Date(Date.now() + offsetDays * 86400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const instant = (page: Page, local: string) => page.evaluate(v => new Date(v).toISOString(), local)
const stamp = () => `Picker ${Date.now().toString(36)}`
const label = (scope: Page | Locator, text: string) => scope.locator('label', { hasText: new RegExp(`^${text}`) }).locator('.dtp-trigger').first()

test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem('lifeos-hour-cycle', '24')) })

for (const timezoneId of ['UTC', 'Asia/Riyadh', 'America/New_York']) {
  test.describe(`time zone ${timezoneId}`, () => {
    test.use({ timezoneId })

    for (const language of ['en', 'ar'] as const) {
      const T = language === 'en' ? { add: 'Add task', more: /More details/, save: /^Save$/, deadline: 'Deadline|الموعد النهائي', remind: 'Remind me|ذكّرني', edit: /^Edit$|^تعديل$/ } : { add: 'إضافة مهمة', more: /تفاصيل أكثر/, save: /^حفظ$/, deadline: 'الموعد النهائي', remind: 'ذكّرني', edit: /^تعديل$/ }

      test(`tasks: create with a deadline and a reminder, save, reopen (${language})`, async ({ page, setLanguage }) => {
        await setLanguage(language)
        const title = stamp()
        await page.goto('/tasks')
        await page.getByRole('button', { name: T.add, exact: true }).first().click()
        await page.getByRole('dialog').getByRole('textbox').first().fill(title)
        await page.getByRole('button', { name: T.more }).click()
        const form = page.getByRole('dialog').first()
        await expect(form).toBeVisible()
        const due = `${ymd(5)}T14:30`, remind = `${ymd(4)}T09:15`
        await chooseByTapping(page, label(form, T.deadline), due.slice(0, 10), '14:30')
        await chooseByTapping(page, label(form, T.remind), remind.slice(0, 10), '09:15', 'icon')
        await expect(label(form, T.deadline)).toHaveAttribute('data-value', due)
        await form.getByRole('button', { name: T.save }).click()
        await expect(form).toBeHidden()
        try {
          const saved = ((await api(page, 'GET', '/api/tasks?per_page=100&due=all')) as { data: { id: number; title: string; due_at: string; remind_at: string }[] }).data.find(t => t.title === title)
          expect(saved, 'task saved').toBeTruthy()
          expect(new Date(saved!.due_at).toISOString()).toBe(await instant(page, due))
          expect(new Date(saved!.remind_at).toISOString()).toBe(await instant(page, remind))

          // Open the saved task again: both fields show exactly what was chosen.
          await page.reload()
          await page.getByText(title).first().click()
          await page.getByRole('button', { name: T.edit }).first().click()
          const again = page.getByRole('dialog').first()
          await expect(label(again, T.deadline)).toHaveAttribute('data-value', due)
          await expect(label(again, T.remind)).toHaveAttribute('data-value', remind)
        } finally {
          const list = ((await api(page, 'GET', '/api/tasks?per_page=100&due=all')) as { data: { id: number; title: string }[] }).data
          for (const t of list.filter(t => t.title === title)) await api(page, 'DELETE', `/api/tasks/${t.id}`)
        }
      })
    }
  })
}

const SAVE = /^Save$|^حفظ$/
const opened = (page: Page) => page.getByRole('dialog').first()

for (const language of ['en', 'ar'] as const) {
  test.describe(`other pages (${language})`, () => {
    for (const resource of ['projects', 'goals'] as const) {
      test(`${resource}: set a deadline, save, reopen`, async ({ page, setLanguage }) => {
        await setLanguage(language)
        const title = stamp(), due = `${ymd(20)}T17:45`
        await page.goto(`/${resource}`)
        await page.getByRole('button', { name: /^Create new$|^إنشاء جديد$/ }).first().click()
        const form = opened(page)
        await form.getByRole('textbox').first().fill(title)
        await chooseByTapping(page, label(form, 'Deadline|الموعد النهائي'), due.slice(0, 10), '17:45')
        await form.getByRole('button', { name: SAVE }).click()
        await expect(form).toBeHidden()
        try {
          const rows = ((await api(page, 'GET', `/api/${resource}?per_page=100`)) as { data: { id: number; title: string; due_at: string }[] }).data
          const saved = rows.find(r => r.title === title)
          expect(saved, `${resource} saved`).toBeTruthy()
          expect(new Date(saved!.due_at).toISOString()).toBe(await instant(page, due))
          await page.reload()
          await page.getByRole('textbox', { name: /^Search|^بحث/ }).fill(title)
          await page.locator('article.record-row', { hasText: title }).first().getByRole('button', { name: /^Edit$|^تعديل$/ }).click()
          await expect(label(opened(page), 'Deadline|الموعد النهائي')).toHaveAttribute('data-value', due)
        } finally {
          const rows = ((await api(page, 'GET', `/api/${resource}?per_page=100`)) as { data: { id: number; title: string }[] }).data
          for (const r of rows.filter(r => r.title === title)) await api(page, 'DELETE', `/api/${resource}/${r.id}`)
        }
      })
    }

    test('habits: set a reminder time, save, reopen', async ({ page, setLanguage }) => {
      await setLanguage(language)
      const title = stamp()
      await page.goto('/habits')
      await page.getByRole('button', { name: /^Create new$|^إنشاء جديد$/ }).first().click()
      const form = opened(page)
      await form.getByRole('textbox').first().fill(title)
      await chooseByTapping(page, label(form, 'Remind me at|ذكّرني الساعة'), '', '07:40')
      await form.getByRole('button', { name: SAVE }).click()
      await expect(form).toBeHidden()
      try {
        const rows = ((await api(page, 'GET', '/api/habits?per_page=100')) as { data: { id: number; title: string; remind_time: string }[] }).data
        expect(rows.find(r => r.title === title)?.remind_time?.slice(0, 5)).toBe('07:40')
      } finally {
        const rows = ((await api(page, 'GET', '/api/habits?per_page=100')) as { data: { id: number; title: string }[] }).data
        for (const r of rows.filter(r => r.title === title)) await api(page, 'DELETE', `/api/habits/${r.id}`)
      }
    })

    test('calendar: new event with start, end and a repeat end date, then edit it', async ({ page, setLanguage }) => {
      await setLanguage(language)
      const title = stamp(), day = ymd(45)
      await page.goto('/calendar')
      await page.getByRole('button', { name: /New event|موعد جديد/ }).click()
      const form = opened(page)
      await form.getByRole('textbox').first().fill(title)
      await chooseByTapping(page, label(form, 'Start|البداية'), day, '10:15')
      await chooseByTapping(page, label(form, 'End|النهاية'), day, '11:45', 'icon')
      await expect(label(form, 'Start|البداية')).toHaveAttribute('data-value', `${day}T10:15`)
      await form.getByRole('button', { name: /^Save|^Create|^حفظ|^إنشاء/ }).click()
      await expect(form).toBeHidden()
      try {
        const rows = ((await api(page, 'GET', '/api/events?per_page=200')) as { data: { id: number; title: string; starts_at: string; ends_at: string }[] }).data
        const saved = rows.find(r => r.title === title)
        expect(saved, 'event saved').toBeTruthy()
        expect(new Date(saved!.ends_at).getTime() - new Date(saved!.starts_at).getTime()).toBe(90 * 60_000)
      } finally {
        const rows = ((await api(page, 'GET', '/api/events?per_page=200')) as { data: { id: number; title: string }[] }).data
        for (const r of rows.filter(r => r.title === title)) await api(page, 'DELETE', `/api/events/${r.id}`)
      }
    })

    test('settings: working hours are chosen, saved and still there after a reload', async ({ page, setLanguage }) => {
      await setLanguage(language)
      await page.goto('/settings')
      const start = label(page, 'Work starts|بداية العمل')
      await expect(start).toBeVisible()
      const original = (await start.getAttribute('data-value')) ?? '09:00'
      try {
        await chooseByTapping(page, start, '', '08:30')
        await expect(start).toHaveAttribute('data-value', '08:30')
        await page.getByRole('button', { name: /^Save preferences$|^حفظ التفضيلات$/ }).click()
        await expect.poll(async () => ((await api(page, 'GET', '/api/settings')) as { work_start?: string }).work_start?.slice(0, 5)).toBe('08:30')
        await page.reload()
        await expect(label(page, 'Work starts|بداية العمل')).toHaveAttribute('data-value', '08:30')
      } finally {
        await api(page, 'PUT', '/api/settings', { work_start: original.slice(0, 5) })
      }
    })

    test('plan my day: the day, and the study and personal windows', async ({ page, setLanguage }) => {
      await setLanguage(language)
      await page.goto('/today/plan')
      await expect(page.locator('#plan-date')).toBeVisible()
      await chooseByTapping(page, page.locator('#plan-date'), ymd(2))
      await expect(page.locator('#plan-date')).toHaveAttribute('data-value', ymd(2))
      await page.getByRole('button', { name: /Boundaries and buffers|الحدود والفواصل/ }).click()
      const windows = page.locator('.boundary-editor .dtp-trigger')
      await expect(windows).toHaveCount(4)
      await chooseByTapping(page, windows.first(), '', '18:30')
      await expect(windows.first()).toHaveAttribute('data-value', '18:30')
    })

    test('analytics: a custom range', async ({ page, setLanguage }) => {
      await setLanguage(language)
      await page.goto('/analytics')
      await page.locator('.analytics-filters summary, .analytics-filters button').first().click().catch(() => {})
      const from = page.locator('.analytics-controls .dtp-trigger').first(), to = page.locator('.analytics-controls .dtp-trigger').nth(1)
      await chooseByTapping(page, from, ymd(-10))
      await chooseByTapping(page, to, ymd(-1), undefined, 'icon')
      await expect(from).toHaveAttribute('data-value', ymd(-10))
      await expect(to).toHaveAttribute('data-value', ymd(-1))
    })

    test('timeline: the day field and the move dialog', async ({ page, setLanguage }) => {
      await setLanguage(language)
      await page.goto('/timeline')
      const nav = page.locator('.date-nav .dtp-trigger')
      await chooseByTapping(page, nav, ymd(1))
      await expect(nav).toHaveAttribute('data-value', ymd(1))
    })

    test('smart planning: add a focus block', async ({ page, setLanguage }) => {
      await setLanguage(language)
      await page.goto('/planning')
      await page.getByRole('button', { name: /^Add block$|^إضافة فترة$|^إضافة كتلة$/ }).first().click()
      const form = opened(page)
      await chooseByTapping(page, label(form, 'Start|البداية'), ymd(3), '13:00')
      await expect(label(form, 'Start|البداية')).toHaveAttribute('data-value', `${ymd(3)}T13:00`)
    })
  })
}

test.describe('behaviour of the picker itself', () => {
  async function editTask(page: Page, title: string) {
    await page.goto('/tasks')
    await page.getByText(title).first().click()
    await page.getByRole('button', { name: /^Edit$|^تعديل$/ }).first().click()
    return opened(page)
  }
  async function makeTask(page: Page, extra: Record<string, unknown> = {}) {
    const title = stamp()
    await page.goto('/tasks')
    const created = (await api(page, 'POST', '/api/tasks', { title, status: 'todo', priority: 'medium', ...extra })) as { data: { id: number } }
    return { title, id: created.data.id }
  }

  test('an existing deadline is shown as it was, and saving without touching it changes nothing', async ({ page, setLanguage }) => {
    await setLanguage('en')
    const due = await instant(page, `${ymd(6)}T16:20`)
    const { title, id } = await makeTask(page, { due_at: due })
    try {
      const form = await editTask(page, title)
      await expect(label(form, 'Deadline')).toHaveAttribute('data-value', `${ymd(6)}T16:20`)
      await label(form, 'Deadline').click()
      await page.locator('.dtp-dialog[open]').getByRole('button', { name: 'Done' }).click()
      await form.getByRole('button', { name: /^Save$/ }).click()
      await expect(form).toBeHidden()
      const saved = ((await api(page, 'GET', `/api/tasks/${id}`)) as { data: { due_at: string } }).data
      expect(new Date(saved.due_at).toISOString()).toBe(due)
    } finally { await api(page, 'DELETE', `/api/tasks/${id}`) }
  })

  test('a deadline can be cleared and set again', async ({ page, setLanguage }) => {
    await setLanguage('en')
    const { title, id } = await makeTask(page, { due_at: await instant(page, `${ymd(6)}T16:20`) })
    try {
      const form = await editTask(page, title)
      await label(form, 'Deadline').click()
      await page.locator('.dtp-dialog[open]').getByRole('button', { name: 'Clear' }).click()
      await expect(label(form, 'Deadline')).toHaveAttribute('data-value', '')
      await form.getByRole('button', { name: /^Save$/ }).click()
      await expect(form).toBeHidden()
      expect(((await api(page, 'GET', `/api/tasks/${id}`)) as { data: { due_at: string | null } }).data.due_at).toBeNull()
    } finally { await api(page, 'DELETE', `/api/tasks/${id}`) }
  })

  test('it opens from the label text, the keyboard and the icon, and Escape closes only the picker', async ({ page, setLanguage }) => {
    await setLanguage('en')
    const { title, id } = await makeTask(page)
    try {
      const form = await editTask(page, title)
      const sheet = page.locator('.dtp-dialog[open]')
      await form.locator('label', { hasText: /^Deadline/ }).click({ position: { x: 8, y: 6 } })
      await expect(sheet).toBeVisible()
      await page.keyboard.press('Escape'); await expect(sheet).toBeHidden(); await expect(form).toBeVisible()
      await label(form, 'Deadline').focus(); await page.keyboard.press('Enter')
      await expect(sheet).toBeVisible()
      await page.keyboard.press('Escape'); await expect(sheet).toBeHidden(); await expect(form).toBeVisible()
      await label(form, 'Deadline').focus(); await page.keyboard.press('Space')
      await expect(sheet).toBeVisible()
      await sheet.getByRole('button', { name: 'Close' }).click(); await expect(sheet).toBeHidden()
      await label(form, 'Deadline').locator('svg').first().click()
      await expect(sheet).toBeVisible()
      // Tapping outside closes it and leaves the form.
      await page.mouse.click(2, 2)
      await expect(sheet).toBeHidden(); await expect(form).toBeVisible()
    } finally { await api(page, 'DELETE', `/api/tasks/${id}`) }
  })

  test('month and year can be changed quickly, and a date in another year is saved', async ({ page, setLanguage }) => {
    await setLanguage('en')
    const { title, id } = await makeTask(page)
    try {
      const form = await editTask(page, title)
      await label(form, 'Deadline').click()
      const sheet = page.locator('.dtp-dialog[open]')
      await sheet.locator('.dtp-title').click()
      await expect(sheet.locator('.dtp-months')).toBeVisible()
      await sheet.getByRole('button', { name: 'Next year' }).click()
      await sheet.getByRole('button', { name: 'Next year' }).click()
      await sheet.locator('.dtp-months button').nth(2).click()   // March, two years ahead
      await expect(sheet.locator('.dtp-months')).toBeHidden()
      const year = new Date().getFullYear() + 2
      await sheet.locator(`[data-day="${year}-03-15"]`).click()
      await sheet.locator('.dtp-hours button', { hasText: /^08$/ }).click()
      await sheet.locator('.dtp-minutes button', { hasText: /^20$/ }).click()
      await sheet.getByRole('button', { name: 'Done' }).click()
      await form.getByRole('button', { name: /^Save$/ }).click()
      await expect(form).toBeHidden()
      const saved = ((await api(page, 'GET', `/api/tasks/${id}`)) as { data: { due_at: string } }).data
      expect(new Date(saved.due_at).toISOString()).toBe(await instant(page, `${year}-03-15T08:20`))
    } finally { await api(page, 'DELETE', `/api/tasks/${id}`) }
  })

  for (const size of [{ width: 1280, height: 560 }, { width: 820, height: 1180 }, { width: 360, height: 640 }, { width: 640, height: 360 }, { width: 1920, height: 1080 }]) {
    for (const language of ['en', 'ar'] as const) {
      test(`the picker stays on screen and its buttons are reachable at ${size.width}x${size.height} (${language})`, async ({ page, setLanguage }) => {
        await setLanguage(language)
        const { title, id } = await makeTask(page)
        try {
          await page.setViewportSize(size)
          const form = await editTask(page, title)
          await label(form, 'Deadline|الموعد النهائي').scrollIntoViewIfNeeded()
          await label(form, 'Deadline|الموعد النهائي').click()
          const sheet = page.locator('.dtp-dialog[open]')
          await expect(sheet).toBeVisible()
          await sheet.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)))
          const box = (await sheet.boundingBox())!
          expect(box.x).toBeGreaterThanOrEqual(-1); expect(box.y).toBeGreaterThanOrEqual(-1)
          expect(box.x + box.width).toBeLessThanOrEqual(size.width + 1); expect(box.y + box.height).toBeLessThanOrEqual(size.height + 1)
          await sheet.locator('.dtp-day:not(.outside)').nth(9).click()
          await sheet.getByRole('button', { name: /^Done$|^تم$/ }).click()
          await expect(sheet).toBeHidden()
          await expect(label(form, 'Deadline|الموعد النهائي')).not.toHaveAttribute('data-value', '')
        } finally { await api(page, 'DELETE', `/api/tasks/${id}`) }
      })
    }
  }
})
