import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import { WeeklyDraftSettings, type WeeklyDraft } from '../features/settings/WeeklyDraftSettings'

type Call = [string, RequestInit | undefined]
function stub(handler: (url: string, init?: RequestInit) => unknown) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => { const body = handler(url, init); return new Response(JSON.stringify(body ?? {}), { status: body === undefined ? 404 : 200 }) })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname + l.search}</p> }
const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter initialEntries={['/']}><ToastProvider><AuthProvider>
  <Routes><Route path="/" element={children} /><Route path="/assistant" element={<Where />} /></Routes>
</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
beforeEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })

const draft: WeeklyDraft = { settings: { enabled: false, weekday: 0, time: '18:00', template_id: null, last_week: null }, next_week: '2026-11-02' }
const handler = (url: string, init?: RequestInit) => {
  if (/\/api\/user$/.test(url)) return { id: 1, name: 'A', email: 'a@x.io' }
  if (/weekly-draft$/.test(url)) {
    if (init?.method === 'PUT') return { ...draft, settings: { ...draft.settings, ...JSON.parse(init.body as string) } }
    if (init?.method === 'POST') return { conversation: { id: 'd0d0d0d0-0000-4000-8000-000000000016' } }
    return draft
  }
  if (/templates$/.test(url)) return { templates: [{ id: 7, name: 'Deep week', blocks: [], minutes: 150, days: 2, updated_at: '2026-10-30T10:00:00Z' }] }
  return undefined
}
const calls = (f: ReturnType<typeof stub>) => f.mock.calls as unknown as Call[]

describe('weekly plan drafts', () => {
  it('switches drafts on, picks a day, a time and a template', async () => {
    localStorage.setItem('lifeos-language', 'en')
    const fetcher = stub(handler)
    render(wrap(<WeeklyDraftSettings />))
    const toggle = await screen.findByLabelText('Prepare a weekly plan draft')
    expect(toggle).not.toBeChecked()
    expect(screen.getByLabelText('Day')).toHaveDisplayValue('Sunday')
    expect(await screen.findByRole('option', { name: 'Template: Deep week' })).toBeInTheDocument()

    fireEvent.click(toggle)
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '16:30' } })
    fireEvent.change(screen.getByLabelText('Plan from'), { target: { value: '7' } })
    await waitFor(() => expect(calls(fetcher).filter(c => c[1]?.method === 'PUT').map(c => JSON.parse(c[1]!.body as string)))
      .toEqual([{ enabled: true }, { weekday: 5 }, { time: '16:30' }, { template_id: 7 }]))
  })

  it('prepares a draft now and opens it in Copilot', async () => {
    localStorage.setItem('lifeos-language', 'ar')
    const fetcher = stub(handler)
    render(wrap(<WeeklyDraftSettings />))
    fireEvent.click(await screen.findByRole('button', { name: 'أعدّ مسودة الآن' }))
    expect(await screen.findByTestId('where')).toHaveTextContent('/assistant?c=d0d0d0d0-0000-4000-8000-000000000016')
    const post = calls(fetcher).find(c => c[1]?.method === 'POST')!
    expect(JSON.parse(post[1]!.body as string)).toEqual({ language: 'ar' })
  })

  it('is disabled while AI features are off', async () => {
    localStorage.setItem('lifeos-language', 'en')
    stub(handler)
    render(wrap(<WeeklyDraftSettings disabled />))
    expect(await screen.findByLabelText('Prepare a weekly plan draft')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Prepare a draft now' })).toBeDisabled()
  })
})
