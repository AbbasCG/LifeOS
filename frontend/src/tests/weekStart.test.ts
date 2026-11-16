import { afterEach, describe, expect, it, vi } from 'vitest'
import { accountWeekStart, daysIntoWeek, setCalendarPrefs, startOfWeek, weekdayOrder } from '../lib/weekStart'
import { weekStartOf } from '../lib/dates'
import { doneNow, type Habit } from '../lib/quickActions'
import { monthGrid, weekdayIndex } from '../lib/dateTime'

afterEach(() => { setCalendarPrefs(null); vi.useRealTimers() })

// 2027-03-10 is a Wednesday; the Sunday before it is 03-07, the Saturday before it 03-06, the Monday 03-08.
describe('week start helpers', () => {
  it('finds the first day of the week for Saturday, Sunday and Monday starts', () => {
    expect(startOfWeek('2027-03-10', 6)).toBe('2027-03-06')
    expect(startOfWeek('2027-03-10', 0)).toBe('2027-03-07')
    expect(startOfWeek('2027-03-10', 1)).toBe('2027-03-08')
  })
  it('keeps a first day as itself and moves the last day of the old week into the new one', () => {
    expect(startOfWeek('2027-03-06', 6)).toBe('2027-03-06')   // Saturday, week starts Saturday
    expect(startOfWeek('2027-03-06', 1)).toBe('2027-03-01')   // the same Saturday is the 6th day of a Monday week
    expect(startOfWeek('2027-03-07', 0)).toBe('2027-03-07')   // Sunday, week starts Sunday
    expect(startOfWeek('2027-03-07', 1)).toBe('2027-03-01')   // the same Sunday closes a Monday week
    expect(startOfWeek('2027-03-01', 6)).toBe('2027-02-27')   // across a month boundary
  })
  it('counts the days into the week', () => {
    expect(daysIntoWeek('2027-03-10', 6)).toBe(4)
    expect(daysIntoWeek('2027-03-10', 0)).toBe(3)
    expect(daysIntoWeek('2027-03-10', 1)).toBe(2)
    expect(daysIntoWeek('2027-03-07', 1)).toBe(6)
  })
  it('orders the weekday columns from the first day (0 = Sunday)', () => {
    expect(weekdayOrder(1)).toEqual([1, 2, 3, 4, 5, 6, 0])
    expect(weekdayOrder(0)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(weekdayOrder(6)).toEqual([6, 0, 1, 2, 3, 4, 5])
  })
  it('defaults to Monday and ignores values the server could never send', () => {
    expect(accountWeekStart()).toBe(1)
    setCalendarPrefs({ week_start: 6 }); expect(accountWeekStart()).toBe(6)
    setCalendarPrefs({ week_start: 9 }); expect(accountWeekStart()).toBe(1)
    setCalendarPrefs({ week_start: 'x' }); expect(accountWeekStart()).toBe(1)
  })
  it('lets the account setting drive the current week, the month grid and weekly habits', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2027, 2, 10, 12))   // Wednesday 10 March 2027, local time
    expect(weekStartOf()).toBe('2027-03-08')
    setCalendarPrefs({ week_start: 6 })
    expect(weekStartOf()).toBe('2027-03-06')
    expect(weekdayIndex('2027-03-06')).toBe(0)
    expect(monthGrid('2027-03-10')[0].day).toBe('2027-02-27')   // 1 March 2027 is a Monday: a Saturday-first grid starts two days before it
    // Done on Sunday 7 March: that counts for "this week" on Wednesday when weeks start on Saturday or Sunday, not when they start on Monday.
    const habit = { id: 1, title: 'Read', recurrence: 'weekly', entries: [{ date: '2027-03-07' }] } as unknown as Habit
    expect(doneNow(habit, '2027-03-10')).toBe(true)
    setCalendarPrefs({ week_start: 1 })
    expect(doneNow(habit, '2027-03-10')).toBe(false)
    setCalendarPrefs({ week_start: 0 })
    expect(doneNow(habit, '2027-03-10')).toBe(true)
  })
})
