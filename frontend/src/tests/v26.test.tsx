import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter, Link, Route, Routes } from 'react-router'
import { useState } from 'react'
import { installRadioGroups } from '../lib/radioGroups'
import { announce } from '../lib/announce'
import { LanguageProvider } from '../contexts/LanguageContext'
import RouteAnnouncer from '../components/layout/RouteAnnouncer'

function Group({ options, dir, arrowSelect, disabled = [] }: { options: string[]; dir?: 'rtl'; arrowSelect?: false; disabled?: string[] }) {
  const [value, setValue] = useState(options[1])
  return <div dir={dir}>
    <button>before</button>
    <div role="radiogroup" aria-label="Show" style={dir ? { direction: dir } : undefined} data-arrow-select={arrowSelect === false ? 'false' : undefined}>
      {options.map(o => <button key={o} type="button" role="radio" aria-checked={value === o} disabled={disabled.includes(o)} onClick={() => setValue(o)}>{o}</button>)}
    </div>
    <output>{value}</output>
  </div>
}

let uninstall = () => {}
beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en') })
afterEach(() => { uninstall(); vi.useRealTimers() })
const install = () => { uninstall = installRadioGroups() }
const radio = (name: string) => screen.getByRole('radio', { name })
const flush = () => act(async () => { await Promise.resolve() })

describe('radio groups from the keyboard', () => {
  it('have one Tab stop, on the checked option', async () => {
    render(<Group options={['All', 'Late', 'Today']} />); install(); await flush()
    expect(radio('Late')).toHaveAttribute('tabindex', '0')
    expect(radio('All')).toHaveAttribute('tabindex', '-1')
    expect(radio('Today')).toHaveAttribute('tabindex', '-1')
  })

  it('arrow keys move and select, wrap around, and Home/End jump to the ends', async () => {
    render(<Group options={['All', 'Late', 'Today']} />); install(); await flush()
    radio('Late').focus()
    fireEvent.keyDown(radio('Late'), { key: 'ArrowRight' })
    expect(radio('Today')).toHaveFocus()
    expect(radio('Today')).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(radio('Today'), { key: 'ArrowDown' })
    expect(radio('All')).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(radio('All'), { key: 'End' })
    expect(radio('Today')).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(radio('Today'), { key: 'Home' })
    expect(radio('All')).toHaveAttribute('aria-checked', 'true')
    await flush()
    expect(radio('All')).toHaveAttribute('tabindex', '0')
    expect(radio('Today')).toHaveAttribute('tabindex', '-1')
  })

  it('follows reading direction in Arabic and skips disabled options', async () => {
    render(<Group options={['A', 'B', 'C', 'D']} dir="rtl" disabled={['C']} />); install(); await flush()
    radio('B').focus()
    // In right-to-left, Left is "forward".
    fireEvent.keyDown(radio('B'), { key: 'ArrowLeft' })
    expect(radio('D')).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(radio('D'), { key: 'ArrowRight' })
    expect(radio('B')).toHaveAttribute('aria-checked', 'true')
  })

  it('only moves focus in groups that save on pick', async () => {
    render(<Group options={['30m', '1h', '2h']} arrowSelect={false} />); install(); await flush()
    radio('1h').focus()
    fireEvent.keyDown(radio('1h'), { key: 'ArrowRight' })
    expect(radio('2h')).toHaveFocus()
    expect(radio('1h')).toHaveAttribute('aria-checked', 'true')
  })

  it('leaves modified keys alone', async () => {
    render(<Group options={['All', 'Late']} />); install(); await flush()
    radio('Late').focus()
    fireEvent.keyDown(radio('Late'), { key: 'ArrowLeft', altKey: true })
    expect(radio('Late')).toHaveAttribute('aria-checked', 'true')
  })
})

describe('announcements', () => {
  it('speak through one polite live region and repeat when the same message comes again', () => {
    vi.useFakeTimers()
    announce('12 task(s)')
    const region = document.querySelector('[data-announcer]')!
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toHaveAttribute('role', 'status')
    vi.advanceTimersByTime(100)
    expect(region.textContent).toBe('12 task(s)')
    announce('12 task(s)')
    expect(region.textContent).toBe('')
    vi.advanceTimersByTime(100)
    expect(region.textContent).toBe('12 task(s)')
    expect(document.querySelectorAll('[data-announcer]')).toHaveLength(1)
  })

  it('name each page in the title and announce a page change, but not the first page', async () => {
    vi.useFakeTimers()
    render(<LanguageProvider><MemoryRouter initialEntries={['/tasks']}><RouteAnnouncer />
      <main><Routes><Route path="/tasks" element={<><h1>Tasks</h1><Link to="/goals">goals</Link></>} /><Route path="/goals" element={<h1>Goals</h1>} /></Routes></main>
    </MemoryRouter></LanguageProvider>)
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(document.title).toBe('Tasks · LifeOS')
    expect(document.querySelector('[data-announcer]')?.textContent ?? '').not.toBe('Tasks')
    fireEvent.click(screen.getByText('goals'))
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(document.title).toBe('Goals · LifeOS')
    expect(document.querySelector('[data-announcer]')?.textContent).toBe('Goals')
  })
})
