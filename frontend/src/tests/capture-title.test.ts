import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readCapture } from '../lib/capture'
import { setAccountZone } from '../lib/accountDay'

/**
 * Quick Add saves the title WITHOUT the words it understood (the day, the time, the length). The text as typed stays in `task.title`;
 * the cleaned one is `title`. The clock is pinned: noon on Thursday 19 November 2026 in Amsterdam.
 */
const NOW = new Date('2026-11-19T11:00:00Z')
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: NOW }); setAccountZone('Europe/Amsterdam') })
afterEach(() => { vi.useRealTimers(); setAccountZone(undefined) })
const title = (text: string) => readCapture(text, NOW).title

describe('English: the understood words are taken out wherever they are', () => {
  it.each([
    ['Call the bank tomorrow at 10 for 30 minutes', 'Call the bank'],
    ['tomorrow at 10 call the bank', 'call the bank'],
    ['Tomorrow at 7 PM, study Laravel for one hour.', 'study Laravel.'],
    ['Call the bank tomorrow at 10, then email Sara', 'Call the bank, then email Sara'],
    ['Meet Sara tomorrow at 3pm about the loan', 'Meet Sara about the loan'],
    ['Plan for tomorrow at 3pm', 'Plan'],
    ['Study Laravel tomorrow at 7pm for one hour', 'Study Laravel'],
    ['Too late today at 8am for 45 minutes', 'Too late'],
    ['call the dentist at 3pm', 'call the dentist'],
    ['Write report for 2 hours', 'Write report'],
    ['Plan the week for 45 minutes', 'Plan the week'],
    ['Night shift tomorrow at 1:30am for 2 hours', 'Night shift'],
    ['Visit Tomorrowland at 7pm', 'Visit Tomorrowland'],
    ['Pay rent the day after tomorrow at 9:15', 'Pay rent'],
    ['Read tonight at 9 pm for an hour', 'Read'],
  ])('"%s" → "%s"', (text, expected) => expect(title(text)).toBe(expected))

  it('numbers that are part of the title survive', () => {
    expect(title('Book 2 tickets tomorrow at 10')).toBe('Book 2 tickets')
    expect(title('Buy 3 apples for 2 hours')).toBe('Buy 3 apples')
    expect(title('Call 0612345678 at 9')).toBe('Call 0612345678')
    expect(title('Read chapter 12 tomorrow at 8 for 20 minutes')).toBe('Read chapter 12')
  })

  it('a phrase with no time or length keeps the title as typed, a day word alone stays', () => {
    expect(title('buy milk')).toBe('buy milk')
    expect(title('  Pay rent  ')).toBe('Pay rent')
    expect(title('call mum tomorrow')).toBe('call mum tomorrow')
    expect(title('Look at the plan')).toBe('Look at the plan')
    expect(title('Turn the lights on tomorrow at 7')).toBe('Turn the lights on')
  })

  it('only a date and time, or only connectors and stop words left: the text is kept as typed', () => {
    expect(title('tomorrow at 10')).toBe('tomorrow at 10')
    expect(title('tomorrow at 10 for 30 minutes')).toBe('tomorrow at 10 for 30 minutes')
    expect(title('at 10, for 30 minutes.')).toBe('at 10, for 30 minutes.')
    expect(title('the tomorrow at 10')).toBe('the tomorrow at 10')
    expect(title('for tomorrow at 10 - ')).toBe('for tomorrow at 10 -')
  })

  it('the text as typed is still there, and nothing else in the reading changes', () => {
    const r = readCapture('Call the bank tomorrow at 10 for 30 minutes', NOW)
    expect(r.task.title).toBe('Call the bank tomorrow at 10 for 30 minutes')
    expect(r.title).toBe('Call the bank')
    expect(r.task.schedule?.starts_at).toBe('2026-11-20T09:00:00.000Z')
    expect(r.task.estimated_minutes).toBe(30)
    expect(r).toMatchObject({ hasDay: true, time: '10:00', day: '2026-11-20' })
  })
})

describe('Arabic', () => {
  it.each([
    ['اتصل بأحمد بكرة الساعة 5 مساءً لمدة ساعتين', 'اتصل بأحمد'],
    ['بكرة الساعة 5 مساءً اتصل بأحمد', 'اتصل بأحمد'],
    ['اجتماع بعد غد الساعة 9 صباحا', 'اجتماع'],
    ['اجتماع في الساعة ٩ صباحاً غداً', 'اجتماع'],
    ['مراجعة لمدة ٤٥ دقيقة', 'مراجعة'],
    ['قراءة لمدة نصف ساعة', 'قراءة'],
    ['اتصل بالبنك غداً الساعة 10 بخصوص القرض', 'اتصل بالبنك بخصوص القرض'],
    ['احجز 2 تذاكر غدا الساعة 10', 'احجز 2 تذاكر'],
  ])('"%s" → "%s"', (text, expected) => expect(title(text)).toBe(expected))

  it('plain text, a day alone and only a date keep the text as typed', () => {
    expect(title('مراجعة الدرس')).toBe('مراجعة الدرس')
    expect(title('اتصل بأمي بكرة')).toBe('اتصل بأمي بكرة')
    expect(title('غداً الساعة ٥:٣٠ مساء')).toBe('غداً الساعة ٥:٣٠ مساء')
    expect(title('في الساعة 5 لمدة ساعة')).toBe('في الساعة 5 لمدة ساعة')
  })
})

describe('Dutch', () => {
  it.each([
    ['bel Ahmed morgen om 17:00 voor 30 minuten', 'bel Ahmed'],
    ['morgen om 10 uur de bank bellen', 'de bank bellen'],
    ["boodschappen morgen om half 6 's avonds", 'boodschappen'],
    ["sporten vandaag om 5 uur 's middags voor een uur", 'sporten'],
    ['rapport schrijven overmorgen om 9:15', 'rapport schrijven'],
    ['lezen voor anderhalf uur', 'lezen'],
    ['de bank bellen morgen om 10, daarna mailen', 'de bank bellen, daarna mailen'],
    ['koop 5 appels morgen om 9', 'koop 5 appels'],
  ])('"%s" → "%s"', (text, expected) => expect(title(text)).toBe(expected))

  it('plain text, a day alone and only a date keep the text as typed', () => {
    expect(title('koop 5 appels')).toBe('koop 5 appels')
    expect(title('morgenochtend bellen')).toBe('morgenochtend bellen')
    expect(title("vandaag om 5 uur 's middags")).toBe("vandaag om 5 uur 's middags")
    expect(title('morgen om 10 voor een uur')).toBe('morgen om 10 voor een uur')
  })
})
