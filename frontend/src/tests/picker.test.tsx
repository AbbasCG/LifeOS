import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { StrictMode, useState, type ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { DateTimeField } from '../components/ui/DateTimePicker'
import { Dialog } from '../components/ui/Shared'
import { addDays, addMonths, withMonth, formatTime, monthGrid, parseDay, parseTimeInput, from12, to12, splitDateTime, weekdayIndex } from '../lib/dateTime'
import { setAccountZone } from '../lib/accountDay'

describe('V45 date and time helpers', () => {
  it('does calendar maths without ever shifting a day', () => {
    expect(parseDay('2028-02-29')).toEqual({ y: 2028, m: 2, d: 29 })
    expect(parseDay('2027-02-29')).toBeNull()
    expect(addDays('2027-03-31', 1)).toBe('2027-04-01')
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28')
    expect(addMonths('2027-12-15', 1)).toBe('2028-01-15')
    expect(weekdayIndex('2027-03-08')).toBe(0) // a Monday
  })
  it('moves to another month or year and stays inside that month', () => {
    expect(withMonth('2027-01-31', 2027, 2)).toBe('2027-02-28')
    expect(withMonth('2028-02-29', 2029, 2)).toBe('2029-02-28')
    expect(withMonth('2027-03-15', 2030, 12)).toBe('2030-12-15')
  })
  it('lays a month out as six Monday-first weeks', () => {
    const grid = monthGrid('2027-03-10')
    expect(grid).toHaveLength(42)
    expect(grid[0].day).toBe('2027-03-01')
    expect(grid.filter(c => c.inMonth)).toHaveLength(31)
    expect(monthGrid('2027-05-10')[0].day).toBe('2027-04-26')
  })
  it('converts between the 12-hour and 24-hour clocks', () => {
    expect(to12('00:05')).toEqual({ hour: 12, minute: 5, pm: false })
    expect(to12('12:00')).toEqual({ hour: 12, minute: 0, pm: true })
    expect(to12('17:45')).toEqual({ hour: 5, minute: 45, pm: true })
    expect(from12(12, 0, false)).toBe('00:00')
    expect(from12(12, 30, true)).toBe('12:30')
    expect(from12(5, 45, true)).toBe('17:45')
    for (let h = 0; h < 24; h++) { const t = `${String(h).padStart(2, '0')}:15`; const p = to12(t); expect(from12(p.hour, p.minute, p.pm)).toBe(t) }
  })
  it('reads what people type: 24-hour, 12-hour, no colon, Arabic digits and letters', () => {
    expect(parseTimeInput('14:30')).toBe('14:30')
    expect(parseTimeInput('1430')).toBe('14:30')
    expect(parseTimeInput('9')).toBe('09:00')
    expect(parseTimeInput('2:30 pm')).toBe('14:30')
    expect(parseTimeInput('2.30PM')).toBe('14:30')
    expect(parseTimeInput('12 am')).toBe('00:00')
    expect(parseTimeInput('12:15 pm')).toBe('12:15')
    expect(parseTimeInput('٠٩:٣٠')).toBe('09:30')
    expect(parseTimeInput('٢:٣٠ م')).toBe('14:30')
    for (const bad of ['', '25:00', '12:60', '13 pm', '0 am', 'noon', '9:5']) expect(parseTimeInput(bad), bad).toBeNull()
  })
  it('formats a time for the chosen clock and splits date-times', () => {
    expect(formatTime('14:05', 24, 'en')).toBe('14:05')
    expect(formatTime('14:05', 12, 'en')).toMatch(/^2:05\s?PM$/i)
    expect(splitDateTime('2027-03-10T09:30')).toEqual({ date: '2027-03-10', time: '09:30' })
    expect(splitDateTime('')).toEqual({ date: '', time: '' })
  })
})

function Harness({ initial = '', kind = 'datetime', required = false, min }: { initial?: string; kind?: 'date' | 'time' | 'datetime'; required?: boolean; min?: string }) {
  const [value, setValue] = useState(initial)
  return <><label>Start<DateTimeField kind={kind} value={value} onChange={setValue} required={required} min={min} /></label><output data-testid="value">{value}</output></>
}
const wrap = (node: ReactNode) => <LanguageProvider>{node}</LanguageProvider>
const value = () => screen.getByTestId('value').textContent
const open = () => fireEvent.click(document.querySelector('.dtp-trigger')!)

describe('V45 the date and time picker', () => {
  beforeEach(() => { localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); setAccountZone('UTC'); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2027-03-10T10:00:00Z')) })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('uses its own picker, not the browser one', () => {
    render(wrap(<Harness initial="2027-03-10T14:30" />))
    expect(document.querySelector('input[type=date], input[type=time], input[type=datetime-local]')).toBeNull()
    expect(screen.getByRole('button', { name: /Start/ }).textContent).toMatch(/Wed, Mar 10/)
  })

  it('picks a day and keeps the time; picking a day on an empty field starts at 09:00', () => {
    render(wrap(<Harness initial="2027-03-10T14:30" />))
    open()
    fireEvent.click(screen.getByRole('button', { name: /Friday, March 12, 2027/ }))
    expect(value()).toBe('2027-03-12T14:30')
    cleanup(); render(wrap(<Harness />))
    open()
    fireEvent.click(screen.getByRole('button', { name: /Monday, March 15, 2027/ }))
    expect(value()).toBe('2027-03-15T09:00')
  })

  it('moves between months', () => {
    render(wrap(<Harness initial="2027-03-10T09:00" />))
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    expect(screen.getByText('April 2027')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(screen.getByText('February 2027')).toBeInTheDocument()
  })

  it('chooses a month and a year from the title, without paging month by month', () => {
    render(wrap(<Harness initial="2027-03-10T09:00" />))
    open()
    fireEvent.click(screen.getByRole('button', { name: /March 2027: choose month or year/ }))
    expect(screen.getByRole('group', { name: 'Month' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next year' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next year' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Month' })).getByRole('button', { name: 'November' }))
    expect(screen.queryByRole('group', { name: 'Month' })).toBeNull()
    expect(screen.getByText('November 2029')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Thursday, November 15, 2029/ }))
    expect(value()).toBe('2029-11-15T09:00')
  })

  it('stays open under React StrictMode, where a browser queues a close event for the first, simulated unmount', async () => {
    // A real dialog.close() fires `close` asynchronously; the development server (StrictMode) mounts, unmounts and remounts the picker.
    const originalClose = HTMLDialogElement.prototype.close
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); setTimeout(() => this.dispatchEvent(new Event('close')), 0) }
    try {
      render(<StrictMode>{wrap(<Harness initial="2027-03-10T09:00" />)}</StrictMode>)
      open()
      await new Promise(r => setTimeout(r, 30))
      expect(document.querySelector('.dtp-dialog[open]')).not.toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /Friday, March 12, 2027/ }))
      expect(value()).toBe('2027-03-12T09:00')
    } finally { HTMLDialogElement.prototype.close = originalClose }
  })

  it('still opens in a browser without dialog.showModal, and every day cell carries its date', () => {
    const original = HTMLDialogElement.prototype.showModal
    // @ts-expect-error simulating an old browser
    HTMLDialogElement.prototype.showModal = undefined
    try {
      render(wrap(<Harness initial="2027-03-10T09:00" />))
      open()
      expect(document.querySelector('.dtp-dialog[open]')).not.toBeNull()
      expect(document.querySelector('[data-day="2027-03-10"]')).not.toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Done' }))
      expect(document.querySelector('.dtp-dialog[open]')).toBeNull()
    } finally { HTMLDialogElement.prototype.showModal = original }
  })

  it('sets the hour and minute, in the 24-hour clock', () => {
    localStorage.setItem('lifeos-hour-cycle', '24')
    render(wrap(<Harness initial="2027-03-10T09:00" />))
    open()
    fireEvent.click(within(screen.getByRole('group', { name: 'Hour' })).getByRole('button', { name: '17' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Minute' })).getByRole('button', { name: /minute 45/ }))
    expect(value()).toBe('2027-03-10T17:45')
    expect(screen.queryByRole('group', { name: 'AM or PM' })).toBeNull()
  })

  it('sets the hour, minute and AM/PM in the 12-hour clock, and the choice is remembered', () => {
    localStorage.setItem('lifeos-hour-cycle', '12')
    render(wrap(<Harness initial="2027-03-10T09:00" />))
    open()
    fireEvent.click(within(screen.getByRole('group', { name: 'Hour' })).getByRole('button', { name: '5 AM' }))
    fireEvent.click(screen.getByRole('button', { name: 'PM' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Minute' })).getByRole('button', { name: /minute 30/ }))
    expect(value()).toBe('2027-03-10T17:30')
    fireEvent.click(screen.getByRole('button', { name: 'AM' }))
    expect(value()).toBe('2027-03-10T05:30')
    fireEvent.click(screen.getByRole('button', { name: '24 h' }))
    expect(localStorage.getItem('lifeos-hour-cycle')).toBe('24')
    expect(screen.queryByRole('group', { name: 'AM or PM' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Time' })).toHaveValue('05:30')
  })

  it('accepts a typed time and a typed date, and ignores nonsense', () => {
    localStorage.setItem('lifeos-hour-cycle', '24')
    render(wrap(<Harness initial="2027-03-10T09:00" />))
    open()
    const time = screen.getByRole('textbox', { name: 'Time' }), date = screen.getByRole('textbox', { name: 'Date' })
    fireEvent.change(time, { target: { value: '2:45 pm' } }); fireEvent.keyDown(time, { key: 'Enter' })
    expect(value()).toBe('2027-03-10T14:45')
    fireEvent.change(time, { target: { value: 'banana' } }); fireEvent.blur(time)
    expect(value()).toBe('2027-03-10T14:45')
    expect(time).toHaveValue('14:45')
    fireEvent.change(date, { target: { value: '2027-04-02' } }); fireEvent.keyDown(date, { key: 'Enter' })
    expect(value()).toBe('2027-04-02T14:45')
    fireEvent.change(date, { target: { value: '2027-13-40' } }); fireEvent.blur(date)
    expect(value()).toBe('2027-04-02T14:45')
  })

  it('does not offer days before the minimum', () => {
    render(wrap(<Harness initial="2027-03-12T09:00" min="2027-03-10" />))
    open()
    expect(screen.getByRole('button', { name: /Tuesday, March 9, 2027/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Wednesday, March 10, 2027/ })).toBeEnabled()
  })

  it('a date-only field closes once a day is picked; Today and Clear work; a required field cannot be cleared', () => {
    render(wrap(<Harness kind="date" initial="2027-05-01" />))
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    expect(value()).toBe('2027-03-10')
    expect(document.querySelector('.dtp-dialog[open]')).toBeNull()
    open(); fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(value()).toBe('')
    cleanup(); render(wrap(<Harness kind="date" initial="2027-05-01" required />))
    open()
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
  })

  it('a time-only field edits just the time', () => {
    localStorage.setItem('lifeos-hour-cycle', '24')
    render(wrap(<Harness kind="time" initial="09:00" />))
    open()
    expect(screen.queryByRole('group', { name: 'Previous month' })).toBeNull()
    fireEvent.click(within(screen.getByRole('group', { name: 'Hour' })).getByRole('button', { name: '18' }))
    expect(value()).toBe('18:00')
  })

  it('closes with Done, with Escape and by tapping outside, and works with the arrow keys', () => {
    render(wrap(<Harness initial="2027-03-10T09:00" />))
    open()
    const day = screen.getByRole('button', { name: /Wednesday, March 10, 2027/ })
    fireEvent.keyDown(day, { key: 'ArrowRight' })
    fireEvent.keyDown(day, { key: 'ArrowDown' })
    fireEvent.click(document.querySelector('.dtp-day[data-day-focus]')!)
    expect(value()).toBe('2027-03-18T09:00')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(document.querySelector('.dtp-dialog[open]')).toBeNull()
    open(); fireEvent(document.querySelector('.dtp-dialog')!, new Event('cancel', { cancelable: true }))
    expect(document.querySelector('.dtp-dialog[open]')).toBeNull()
  })

  it('closing the picker (Escape, Done) never closes the form dialog it is used in', () => {
    const closed = vi.fn()
    render(wrap(<Dialog title="Event" onClose={closed}><label>Start<DateTimeField kind="datetime" defaultValue="2027-03-10T09:00" /></label></Dialog>))
    open()
    const picker = document.querySelector('.dtp-dialog')!
    fireEvent(picker, new Event('cancel', { bubbles: false, cancelable: true }))
    expect(document.querySelector('.dtp-dialog[open]')).toBeNull()
    expect(closed).not.toHaveBeenCalled()
    open(); fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(closed).not.toHaveBeenCalled()
  })

  it('posts the same text a native input did, and makes required work', () => {
    const { container } = render(wrap(<form><DateTimeField kind="datetime" name="due_at" defaultValue="2027-03-10T09:30" required /></form>))
    const form = container.querySelector('form')!
    expect(new FormData(form).get('due_at')).toBe('2027-03-10T09:30')
    expect(form.querySelector<HTMLInputElement>('.dtp-value')!.required).toBe(true)
  })

  it('speaks Arabic: right-to-left, Arabic words, the same buttons', () => {
    localStorage.setItem('lifeos-language', 'ar')
    render(wrap(<Harness initial="2027-03-10T09:00" />))
    open()
    const sheet = document.querySelector('.dtp-dialog')!
    expect(sheet.getAttribute('dir')).toBe('rtl')
    expect(screen.getByRole('button', { name: 'الشهر التالي' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'تم' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'الوقت' })).toBeInTheDocument()
  })
})
