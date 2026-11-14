import { afterEach, describe, expect, it } from 'vitest'
import { parseCapture, readCapture } from '../lib/capture'
import { setAccountZone } from '../lib/accountDay'
import { spokenHints } from '../lib/quickAdd'

// Noon on Monday 19 October 2026 in the browser's own zone, as the existing capture test uses.
const now = new Date(2026, 9, 19, 12)
const at = (iso?: string | null) => new Date(iso!)
const local = (d: Date) => [d.getDate(), d.getHours(), d.getMinutes()]

afterEach(() => setAccountZone(undefined))

describe('English capture is unchanged', () => {
  it('reads tomorrow, the time and the length', () => {
    const draft = parseCapture('Tomorrow at 7 PM, study Laravel for one hour.', now)
    expect(local(at(draft.schedule?.starts_at))).toEqual([20, 19, 0])
    expect(draft.estimated_minutes).toBe(60)
    expect(draft.status).toBe('inbox')
  })
  it('keeps the title as typed and invents nothing from plain text', () => {
    const r = readCapture('buy milk', now)
    expect(r.task.title).toBe('buy milk')
    expect(r.task.schedule).toBeUndefined()
    expect(r.task.due_at).toBeUndefined()
    expect(r.task.estimated_minutes).toBe(30)
    expect(r.found).toEqual({ start: false, duration: false })
  })
  it('ignores an impossible time and words that merely contain a keyword', () => {
    expect(parseCapture('call at 25', now).schedule).toBeUndefined()
    expect(parseCapture('visit Tomorrowland at 7pm', now).schedule).toBeDefined()
    expect(local(at(parseCapture('visit Tomorrowland at 7pm', now).schedule?.starts_at))[0]).toBe(19)
  })
})

describe('Arabic capture', () => {
  it('reads "بكرة الساعة 5 مساءً لمدة ساعتين"', () => {
    const r = readCapture('اتصل بأحمد بكرة الساعة 5 مساءً لمدة ساعتين', now)
    expect(local(at(r.task.schedule?.starts_at))).toEqual([20, 17, 0])
    expect(r.task.estimated_minutes).toBe(120)
    expect(r.task.title).toBe('اتصل بأحمد بكرة الساعة 5 مساءً لمدة ساعتين')
    expect(r.found).toEqual({ start: true, duration: true })
  })
  it('reads Arabic-Indic digits and minutes', () => {
    expect(local(at(parseCapture('غداً الساعة ٥:٣٠ مساء', now).schedule?.starts_at))).toEqual([20, 17, 30])
    expect(parseCapture('مراجعة لمدة ٤٥ دقيقة', now).estimated_minutes).toBe(45)
  })
  it('reads half and one-and-a-half hours, and the day after tomorrow', () => {
    expect(parseCapture('قراءة لمدة نصف ساعة', now).estimated_minutes).toBe(30)
    expect(parseCapture('قراءة لمدة ساعة ونصف', now).estimated_minutes).toBe(90)
    expect(local(at(parseCapture('اجتماع بعد غد الساعة 9 صباحا', now).schedule?.starts_at))).toEqual([21, 9, 0])
  })
  it('treats 12 at night as midnight and leaves plain Arabic alone', () => {
    expect(local(at(parseCapture('بكرة الساعة 12 ليلا', now).schedule?.starts_at))).toEqual([20, 0, 0])
    expect(parseCapture('مراجعة الدرس', now).schedule).toBeUndefined()
  })
})

describe('Dutch capture', () => {
  it('reads "morgen om 17:00 voor 30 minuten"', () => {
    const r = readCapture('bel Ahmed morgen om 17:00 voor 30 minuten', now)
    expect(local(at(r.task.schedule?.starts_at))).toEqual([20, 17, 0])
    expect(r.task.estimated_minutes).toBe(30)
  })
  it("reads \"om 5 uur 's middags\", \"half 6\" and \"overmorgen\"", () => {
    expect(local(at(parseCapture("vandaag om 5 uur 's middags", now).schedule?.starts_at))).toEqual([19, 17, 0])
    expect(local(at(parseCapture("morgen om half 6 's avonds", now).schedule?.starts_at))).toEqual([20, 17, 30])
    expect(local(at(parseCapture('overmorgen om 9:15', now).schedule?.starts_at))).toEqual([21, 9, 15])
  })
  it('reads an hour, an hour and a half and a quarter of an hour', () => {
    expect(parseCapture('lezen voor een uur', now).estimated_minutes).toBe(60)
    expect(parseCapture('lezen voor anderhalf uur', now).estimated_minutes).toBe(90)
    expect(parseCapture('lezen voor een kwartier', now).estimated_minutes).toBe(15)
  })
  it('does not turn "morgenochtend" or a bare number into a time', () => {
    expect(parseCapture('morgenochtend bellen', now).schedule).toBeUndefined()
    expect(parseCapture('koop 5 appels', now).schedule).toBeUndefined()
  })
})

describe('days and clock times are the account\'s', () => {
  it('uses the account zone, not the device zone, near midnight', () => {
    setAccountZone('Pacific/Auckland')   // UTC+13 in November
    // 23:30 UTC on 7 Nov is already 12:30 on 8 Nov in Auckland, so "tomorrow 09:00" is 9 Nov 09:00 there = 20:00 UTC on the 8th.
    const r = readCapture('tomorrow at 9am', new Date('2026-11-07T23:30:00Z'))
    expect(r.task.schedule).toEqual({ starts_at: '2026-11-08T20:00:00.000Z' })
  })
})

describe('dictated hints in Dutch', () => {
  it('reads when and how important', () => {
    expect(spokenHints('bel de bank morgen dringend')).toEqual({ when: 'tomorrow', priority: 'urgent' })
    expect(spokenHints('rapport sturen volgende week')).toEqual({ when: 'nextweek' })
    expect(spokenHints('planten water geven geen haast')).toEqual({ priority: 'low' })
    expect(spokenHints('boodschappen doen')).toEqual({})
  })
})

describe('a phrase says WHEN TO DO the task, never its deadline', () => {
  it.each([
    ['tomorrow at 7pm for one hour', 60],
    ['اتصل بأحمد بكرة الساعة 5 مساءً لمدة ساعتين', 120],
    ['bel Ahmed morgen om 17:00 voor 30 minuten', 30],
  ])('"%s" gives a start and an estimate and no due date', (phrase, minutes) => {
    const r = readCapture(phrase, now)
    expect(r.task.schedule?.starts_at).toBeTypeOf('string')
    expect(r.task.estimated_minutes).toBe(minutes)
    for (const key of ['due_at', 'due_date', 'due_all_day']) expect(r.task).not.toHaveProperty(key)
  })
  it('a bare "at 5" is 05:00 today, a duration alone only sets the estimate, a day word alone changes nothing', () => {
    expect(local(at(parseCapture('call at 5', now).schedule?.starts_at))).toEqual([19, 5, 0])
    const long = readCapture('write report for 2 hours', now)
    expect(long.task.estimated_minutes).toBe(120)
    expect(long.task.schedule).toBeUndefined()
    expect(long.found).toEqual({ start: false, duration: true })
    expect(parseCapture('call mum tomorrow', now).schedule).toBeUndefined()
  })
})

describe('a time with no day word is reported as such', () => {
  it('hasDay is false for "call the dentist at 3pm" (the tile chooses the day), true with a day word, and the time is the account clock', () => {
    const bare = readCapture('call the dentist at 3pm', now)
    expect(bare.hasDay).toBe(false); expect(bare.time).toBe('15:00')
    for (const phrase of ['call tomorrow at 3pm', 'call today at 3pm', 'bel vandaag om 15:00', 'اتصل بكرة الساعة 3 مساء', 'call the day after tomorrow at 3pm']) {
      const r = readCapture(phrase, now); expect(r.hasDay, phrase).toBe(true); expect(r.time, phrase).toBe('15:00')
    }
    expect(readCapture('buy milk', now)).toMatchObject({ hasDay: false, time: null })
  })
})
