import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import AssistantPage from '../features/AssistantPage'
import { ProposalCard } from '../features/assistant/ProposalCard'
import { TEMPLATES_CHANGED } from '../lib/copilot'
import type { AssistantProposal } from '../lib/api'

type Call = [string, RequestInit | undefined]
const wrap = (children: ReactNode, path = '/assistant') => <ThemeProvider><LanguageProvider><MemoryRouter initialEntries={[path]}><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals() })

const at = '2027-01-04T10:00:00Z'
const conversation = { id: '0d6c1f6e-0000-4000-8000-0000000000bb', title: 'Budget planning', language: 'en', last_message_at: at, created_at: at }
const template = { id: 7, name: 'Deep week', blocks: [{ weekday: 1, start: '09:00', minutes: 90, title: 'Focus: Thesis', task_id: 3 }, { weekday: 3, start: '10:00', minutes: 60, title: 'Writing', task_id: null }], minutes: 150, days: 2, updated_at: at }
const proposal: AssistantProposal = { id: '11111111-2222-4333-8444-555555555555', kind: 'focus_blocks', provider: 'local', status: 'pending', summary: 'Suggested 1 block.', explanation: [], results: null, expires_at: '2027-01-05T10:00:00Z', applied_at: null,
  actions: [{ id: 'a1', type: 'create_event', title: 'Focus: Thesis', task_id: 3, starts_at: '2027-01-05T08:00:00Z', ends_at: '2027-01-05T09:30:00Z', minutes: 90 }] }

function stub(handler: (url: string, init?: RequestInit) => unknown) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => { const body = handler(url, init); return new Response(JSON.stringify(body ?? {}), { status: body === undefined ? 404 : 200 }) })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

describe('week templates', () => {
  it('saves a proposal as a named template and tells the page', async () => {
    const fetcher = stub(url => /\/api\/copilot\/templates$/.test(url) ? { template } : undefined)
    const changed = vi.fn()
    window.addEventListener(TEMPLATES_CHANGED, changed)
    render(wrap(<ProposalCard proposal={proposal} />))
    fireEvent.click(screen.getByRole('button', { name: 'Save as template' }))
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Deep week' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }))
    await waitFor(() => expect(changed).toHaveBeenCalled())
    const post = (fetcher.mock.calls as unknown as Call[]).find(c => c[0].endsWith('/api/copilot/templates'))!
    expect(JSON.parse(post[1]!.body as string)).toEqual({ proposal_id: proposal.id, name: 'Deep week' })
    expect(await screen.findByText(/Saved as a week template/)).toBeInTheDocument()
    window.removeEventListener(TEMPLATES_CHANGED, changed)
  })

  it('labels template proposals and does not offer to save them again', () => {
    render(wrap(<ProposalCard proposal={{ ...proposal, kind: 'template' }} />))
    expect(screen.getByText('Week from your template')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save as template' })).not.toBeInTheDocument()
  })
})

describe('copilot library', () => {
  it('searches conversations, shows the matching line and exports the open one', async () => {
    const fetcher = stub(url => {
      if (/\/api\/user$/.test(url)) return { id: 1, name: 'A', email: 'a@x.io' }
      if (/conversations\?.*q=budget/.test(url)) return { conversations: [{ ...conversation, match: '…the quarterly budget review…' }], suggestions: [], personalization: false, retention_days: 90 }
      if (/conversations\?/.test(url)) return { conversations: [conversation], suggestions: [], personalization: false, retention_days: 90 }
      if (/conversations\/0d6c1f6e/.test(url)) return { conversation, messages: [{ id: 1, role: 'user', content: 'Budget planning', intent: null, provider: null, created_at: at }] }
      if (/templates$/.test(url)) return { templates: [] }
      return undefined
    })
    render(wrap(<AssistantPage />, `/assistant?c=${conversation.id}`))
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search conversations' }), { target: { value: 'budget' } })
    expect(await screen.findByText('…the quarterly budget review…')).toBeInTheDocument()
    expect(screen.getByText('1 conversation(s) found')).toBeInTheDocument()
    expect((fetcher.mock.calls as unknown as Call[]).some(c => c[0].includes('q=budget'))).toBe(true)
    expect(await screen.findByRole('link', { name: 'Export this conversation as Markdown' })).toHaveAttribute('href', `/api/copilot/conversations/${conversation.id}/export?format=md`)
    expect(screen.getByRole('link', { name: 'Export this conversation as JSON' })).toHaveAttribute('href', `/api/copilot/conversations/${conversation.id}/export?format=json`)
  })

  it('plans a week from a template through Copilot and deletes templates after confirmation', async () => {
    const fetcher = stub(url => {
      if (/\/api\/user$/.test(url)) return { id: 1, name: 'A', email: 'a@x.io' }
      if (/conversations\?/.test(url)) return { conversations: [], suggestions: [], personalization: false, retention_days: 90 }
      if (/templates$/.test(url)) return { templates: [template] }
      if (/copilot\/messages$/.test(url)) return { conversation, replayed: false, user_message: { id: 1, role: 'user', content: 'x', intent: null, provider: null, created_at: at }, message: { id: 2, role: 'assistant', content: 'Suggested 2 block(s) from “Deep week”.', intent: 'use_template', provider: 'local', created_at: at } }
      return undefined
    })
    render(wrap(<AssistantPage />))
    expect(await screen.findByText('Deep week')).toBeInTheDocument()
    expect(screen.getByText('2 block(s) · 2 day(s)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Plan next week from “Deep week”' }))
    expect(await screen.findByText('Suggested 2 block(s) from “Deep week”.')).toBeInTheDocument()
    const post = (fetcher.mock.calls as unknown as Call[]).find(c => c[0].endsWith('/api/copilot/messages'))!
    expect(JSON.parse(post[1]!.body as string).message).toBe('Plan next week from my template “Deep week”')

    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    fireEvent.click(screen.getByRole('button', { name: 'Delete template “Deep week”' }))
    expect(confirm).toHaveBeenCalled()
    expect((fetcher.mock.calls as unknown as Call[]).some(c => c[1]?.method === 'DELETE')).toBe(false)
  })
})
