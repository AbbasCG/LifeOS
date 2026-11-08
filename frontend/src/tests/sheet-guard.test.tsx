import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { type ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import QuickAdd from '../components/layout/QuickAdd'
import { BottomSheet, SheetCancel } from '../components/visual'
import { RecordForm } from '../features/RecordForm'
import { openQuickAdd } from '../lib/quickAdd'
import { installRadioGroups } from '../lib/radioGroups'

const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider>{children}</ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
function server(routes: { match: RegExp; method?: string; body: unknown; status?: number }[] = []) {
  const calls: { method: string; url: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET'
    calls.push({ method, url: String(url) })
    const route = routes.find(r => r.match.test(String(url)) && (!r.method || r.method === method))
    return new Response(JSON.stringify(route ? route.body : { data: [] }), { status: route?.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  }))
  return calls
}
beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); server() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const asking = () => screen.queryByRole('alertdialog', { name: 'Discard your changes?' })

function Sheet({ dirty, onClose }: { dirty: boolean; onClose: () => void }) {
  return <BottomSheet title="Edit" onClose={onClose} dirty={() => dirty} footer={<SheetCancel>Cancel</SheetCancel>}><input aria-label="Name" /></BottomSheet>
}
const dialogOf = () => document.querySelector('dialog') as HTMLDialogElement
const escape = () => fireEvent(dialogOf(), new Event('cancel', { cancelable: true }))
const backdrop = () => fireEvent.click(dialogOf())

describe('a sheet with nothing unsaved', () => {
  it.each([['Escape', escape], ['the backdrop', backdrop], ['the close button', () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))], ['Cancel', () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))]])('closes at once with %s', (_name, act) => {
    const onClose = vi.fn(); render(wrap(<Sheet dirty={false} onClose={onClose} />))
    act()
    expect(onClose).toHaveBeenCalledTimes(1); expect(asking()).toBeNull()
  })
})

describe('a sheet with unsaved work', () => {
  it.each([['Escape', escape], ['a tap on the backdrop', backdrop], ['the close button', () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))], ['Cancel', () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))]])('asks first with %s and does not close', (_name, act) => {
    const onClose = vi.fn(); render(wrap(<Sheet dirty onClose={onClose} />))
    act()
    expect(onClose).not.toHaveBeenCalled()
    expect(asking()).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus()
  })

  it('"Keep editing" returns to the form, "Discard" closes', () => {
    const onClose = vi.fn(); render(wrap(<Sheet dirty onClose={onClose} />))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(asking()).toBeNull(); expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape or a backdrop tap while asking means keep editing, never discard', () => {
    const onClose = vi.fn(); render(wrap(<Sheet dirty onClose={onClose} />))
    escape(); expect(asking()).toBeInTheDocument()
    escape(); expect(asking()).toBeNull()
    escape(); backdrop(); expect(asking()).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('uses the Arabic wording in Arabic', () => {
    localStorage.setItem('lifeos-language', 'ar')
    render(wrap(<Sheet dirty onClose={() => {}} />))
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق' }))
    expect(screen.getByRole('alertdialog', { name: 'تجاهل التغييرات؟' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'متابعة التعديل' })).toBeInTheDocument()
  })
})

describe('the task form', () => {
  const open = (onClose = vi.fn(), item: Record<string, unknown> = { title: 'Write report' }) => { render(wrap(<RecordForm resource="tasks" item={item} onSave={() => {}} onClose={onClose} />)); return onClose }
  const cancel = () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

  it('closes at once when nothing was changed', async () => {
    const onClose = open(); await screen.findByRole('textbox', { name: /Title/ })
    cancel(); expect(onClose).toHaveBeenCalledTimes(1); expect(asking()).toBeNull()
  })

  it('asks when the title was edited, and is clean again once it is typed back', async () => {
    const onClose = open(); const title = await screen.findByRole('textbox', { name: /Title/ })
    fireEvent.change(title, { target: { value: 'Write report v2' } })
    cancel(); expect(asking()).toBeInTheDocument(); expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    fireEvent.change(title, { target: { value: 'Write report' } })
    cancel(); expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('counts a choice made with the tiles (priority) as a change', async () => {
    const onClose = open(); await screen.findByRole('textbox', { name: /Title/ })
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Priority' })).getByRole('radio', { name: 'Urgent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(asking()).toBeInTheDocument(); expect(onClose).not.toHaveBeenCalled()
  })

  it('counts an added subtask as a change', async () => {
    const onClose = open(vi.fn(), { title: 'Write report', description: 'x' }); await screen.findByRole('textbox', { name: /Title/ })
    fireEvent.click(screen.getByText('More options'))
    fireEvent.click(screen.getByRole('button', { name: 'Add subtask' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(asking()).toBeInTheDocument(); expect(onClose).not.toHaveBeenCalled()
  })

  it('saving never asks: it closes through the save', async () => {
    const calls = server([{ match: /\/api\/tasks$/, method: 'POST', body: { data: { id: 9 } }, status: 201 }])
    const onClose = open(); const title = await screen.findByRole('textbox', { name: /Title/ })
    fireEvent.change(title, { target: { value: 'Brand new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(asking()).toBeNull()
    expect(calls.some(c => c.method === 'POST')).toBe(true)
  })
})

describe('Quick add', () => {
  const show = async () => { render(wrap(<QuickAdd />)); act(() => openQuickAdd()); return screen.findByRole('textbox', { name: 'Task' }) }

  it('closes at once when empty', async () => {
    await show()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Task' })).toBeNull())
    expect(asking()).toBeNull()
  })

  it('asks once something is typed, and Discard closes it', async () => {
    const box = await show()
    fireEvent.change(box, { target: { value: 'Call mum' } })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(asking()).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Task' })).toHaveValue('Call mum')
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Task' })).toBeNull())
  })

  it('the date tile is a real radio in the "When" group, unchecked until a day is picked', async () => {
    await show()
    const when = screen.getByRole('radiogroup', { name: 'When' })
    const date = within(when).getByRole('radio', { name: /Pick a date/ })
    expect(date).toHaveAttribute('aria-checked', 'false')
    expect(date).toHaveAttribute('aria-haspopup', 'dialog')
    expect(date).not.toHaveAttribute('aria-expanded')
    expect(within(when).getAllByRole('radio')).toHaveLength(5)
  })

  it('an arrow key reaches the date tile without opening the picker or changing "When"', async () => {
    const uninstall = installRadioGroups()
    try {
      await show(); await act(async () => { await Promise.resolve() })
      const when = screen.getByRole('radiogroup', { name: 'When' })
      const week = within(when).getByRole('radio', { name: 'This week' }), date = within(when).getByRole('radio', { name: /Pick a date/ })
      week.focus(); fireEvent.click(week)
      fireEvent.keyDown(week, { key: 'ArrowRight' })
      expect(date).toHaveFocus()
      expect(week).toHaveAttribute('aria-checked', 'true')
      expect(date).toHaveAttribute('aria-checked', 'false')
    } finally { uninstall() }
  })
})

