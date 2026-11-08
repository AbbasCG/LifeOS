import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { useState } from 'react'
import { installRadioGroups } from '../lib/radioGroups'

// Tab lists (Focus modes, briefing sections, AI activity) get the same keyboard behaviour as radio groups; an option that opens a
// dialog (Quick Add's date tile) takes focus from an arrow key without opening it.

function Tabs({ tabs, dir, disabled = [] }: { tabs: string[]; dir?: 'rtl'; disabled?: string[] }) {
  const [value, setValue] = useState(tabs[1])
  return <div dir={dir}>
    <button>before</button>
    <div role="tablist" aria-label="Modes" style={dir ? { direction: dir } : undefined}>
      {tabs.map(tab => <button key={tab} role="tab" type="button" aria-selected={value === tab} disabled={disabled.includes(tab)} onClick={() => setValue(tab)}>{tab}</button>)}
    </div>
    <output>{value}</output>
  </div>
}

function WithPopup() {
  const [value, setValue] = useState('A'), [opened, setOpened] = useState(0)
  return <div role="radiogroup" aria-label="When">
    <button type="button" role="radio" aria-checked={value === 'A'} onClick={() => setValue('A')}>A</button>
    <button type="button" role="radio" aria-checked={value === 'pick'} aria-haspopup="dialog" onClick={() => { setOpened(n => n + 1); setValue('pick') }}>Pick a date</button>
    <button type="button" role="radio" aria-checked={value === 'C'} onClick={() => setValue('C')}>C</button>
    <output aria-label="opened">{opened}</output>
  </div>
}

let uninstall = () => {}
beforeEach(() => { cleanup() })
afterEach(() => { uninstall() })
const install = () => { uninstall = installRadioGroups() }
const tab = (name: string) => screen.getByRole('tab', { name })
const flush = () => act(async () => { await Promise.resolve() })

describe('tab lists from the keyboard', () => {
  it('have one Tab stop, on the selected tab', async () => {
    render(<Tabs tabs={['Focus', 'Short', 'Long']} />); install(); await flush()
    expect(tab('Short')).toHaveAttribute('tabindex', '0')
    expect(tab('Focus')).toHaveAttribute('tabindex', '-1')
    expect(tab('Long')).toHaveAttribute('tabindex', '-1')
  })

  it('arrows move and select, wrap around, and Home/End jump to the ends', async () => {
    render(<Tabs tabs={['Focus', 'Short', 'Long']} />); install(); await flush()
    tab('Short').focus()
    fireEvent.keyDown(tab('Short'), { key: 'ArrowRight' })
    expect(tab('Long')).toHaveFocus(); expect(tab('Long')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(tab('Long'), { key: 'ArrowRight' })
    expect(tab('Focus')).toHaveFocus()
    fireEvent.keyDown(tab('Focus'), { key: 'ArrowLeft' })
    expect(tab('Long')).toHaveFocus()
    fireEvent.keyDown(tab('Long'), { key: 'Home' })
    expect(tab('Focus')).toHaveFocus(); expect(tab('Focus')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(tab('Focus'), { key: 'End' })
    expect(tab('Long')).toHaveFocus()
    await flush()
    expect(tab('Long')).toHaveAttribute('tabindex', '0')
    expect(tab('Focus')).toHaveAttribute('tabindex', '-1')
  })

  it('a horizontal tab list does not answer Up and Down', async () => {
    render(<Tabs tabs={['Focus', 'Short', 'Long']} />); install(); await flush()
    tab('Short').focus()
    fireEvent.keyDown(tab('Short'), { key: 'ArrowDown' })
    fireEvent.keyDown(tab('Short'), { key: 'ArrowUp' })
    expect(tab('Short')).toHaveFocus(); expect(tab('Short')).toHaveAttribute('aria-selected', 'true')
  })

  it('follows reading direction: Right moves backwards in Arabic', async () => {
    render(<Tabs tabs={['Focus', 'Short', 'Long']} dir="rtl" />); install(); await flush()
    tab('Short').focus()
    fireEvent.keyDown(tab('Short'), { key: 'ArrowRight' })
    expect(tab('Focus')).toHaveFocus()
    fireEvent.keyDown(tab('Focus'), { key: 'ArrowLeft' })
    expect(tab('Short')).toHaveFocus()
  })

  it('skips disabled tabs', async () => {
    render(<Tabs tabs={['Focus', 'Short', 'Long']} disabled={['Long']} />); install(); await flush()
    tab('Short').focus()
    fireEvent.keyDown(tab('Short'), { key: 'ArrowRight' })
    expect(tab('Focus')).toHaveFocus()
  })
})

describe('an option that opens a dialog', () => {
  it('receives focus from an arrow key without opening it or changing the selection', async () => {
    render(<WithPopup />); install(); await flush()
    const a = screen.getByRole('radio', { name: 'A' }), pick = screen.getByRole('radio', { name: 'Pick a date' })
    a.focus()
    fireEvent.keyDown(a, { key: 'ArrowRight' })
    expect(pick).toHaveFocus()
    expect(screen.getByLabelText('opened')).toHaveTextContent('0')
    expect(a).toHaveAttribute('aria-checked', 'true')
    // Enter / Space (a click on a button) is what opens it.
    fireEvent.click(pick)
    expect(screen.getByLabelText('opened')).toHaveTextContent('1')
  })

  it('arrows past it still select the ordinary options', async () => {
    render(<WithPopup />); install(); await flush()
    const pick = screen.getByRole('radio', { name: 'Pick a date' })
    pick.focus()
    fireEvent.keyDown(pick, { key: 'ArrowRight' })
    expect(screen.getByRole('radio', { name: 'C' })).toHaveFocus()
    expect(screen.getByRole('radio', { name: 'C' })).toHaveAttribute('aria-checked', 'true')
  })
})
