import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { SwipeSettings } from '../components/SwipeSettings'
import { DEFAULT_SWIPE, normalizeSwipe, resetSwipe, setSwipeAction, swipeTone } from '../lib/swipeActions'

const wrap = (ui: React.ReactNode) => <ThemeProvider><LanguageProvider><ToastProvider>{ui}</ToastProvider></LanguageProvider></ThemeProvider>
beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); act(() => resetSwipe()) })

describe('what each swipe does', () => {
  it('starts as complete to the right and snooze to tomorrow to the left', () => {
    expect(DEFAULT_SWIPE).toEqual({ right: 'complete', left: 'tomorrow' })
  })

  it('makes anything unknown or broken safe', () => {
    expect(normalizeSwipe(null)).toEqual(DEFAULT_SWIPE)
    expect(normalizeSwipe({ right: 'launch-rocket', left: 'delete' })).toEqual({ right: 'complete', left: 'delete' })
    expect(normalizeSwipe('nope')).toEqual(DEFAULT_SWIPE)
  })

  it('colours a delete as danger and a snooze as a warning, never by colour alone', () => {
    expect(swipeTone('delete')).toBe('danger')
    expect(swipeTone('tomorrow')).toBe('warning')
    expect(swipeTone('none')).toBe('')
  })
})

describe('Settings → Swipe actions', () => {
  it('shows the two directions, saves a choice on this device, and resets', () => {
    render(wrap(<SwipeSettings />))
    const right = screen.getByLabelText('Swipe right') as HTMLSelectElement, left = screen.getByLabelText('Swipe left') as HTMLSelectElement
    expect(right.value).toBe('complete'); expect(left.value).toBe('tomorrow')
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()

    fireEvent.change(right, { target: { value: 'delete' } })
    fireEvent.change(left, { target: { value: 'nextweek' } })
    expect(JSON.parse(localStorage.getItem('lifeos-swipe-actions')!)).toEqual({ right: 'delete', left: 'nextweek' })
    expect(right.value).toBe('delete')
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(localStorage.getItem('lifeos-swipe-actions')).toBeNull()
    expect(right.value).toBe('complete')
  })

  it('says in words that delete asks first, and offers every action on both sides', () => {
    render(wrap(<SwipeSettings />))
    const options = [...(screen.getByLabelText('Swipe right') as HTMLSelectElement).options].map(o => o.text)
    expect(options).toEqual(['Complete', 'Snooze to tomorrow', 'Snooze to next week', 'Start focus', 'Delete (asks first)', 'Nothing'])
    act(() => setSwipeAction('left', 'none'))
    expect((screen.getByLabelText('Swipe left') as HTMLSelectElement).value).toBe('none')
  })
})
