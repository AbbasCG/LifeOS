import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import AssistantPage from '../features/AssistantPage'
import { PlanCard, ContextChips, SourceBadge } from '../features/assistant/PlanCard'
import { parseEvents, sendCopilot, type CopilotMessage, type CopilotPlan } from '../lib/copilot'

type Route = { match: RegExp; method?: string; body: unknown; status?: number }
function mockApi(routes: Route[]) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const route = routes.find(r => r.match.test(url) && (!r.method || r.method === (init?.method || 'GET')))
    return new Response(JSON.stringify(route ? route.body : {}), { status: route ? route.status ?? 200 : 404 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const wrap = (children: ReactNode, path = '/assistant') => <ThemeProvider><LanguageProvider><MemoryRouter initialEntries={[path]}><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
const user = { match: /\/api\/user$/, body: { id: 1, name: 'A', email: 'a@x.io' } }
const at = '2027-01-04T10:00:00Z'
const conversation = { id: '0d6c1f6e-0000-4000-8000-0000000000aa', title: 'Plan my week', language: 'en', last_message_at: at, created_at: at }
const plan: CopilotPlan = {
  kind: 'plan_week', title: 'Plan for 4 Jan – 10 Jan', explanation: ['No existing event moves; new blocks only use free time.'],
  conflicts: [{ type: 'unscheduled', title: 'Thesis', detail: 'Not enough work time in this period.', minutes: 120 }],
  alternatives: [{ key: 'balanced', label: 'Everything, by priority', current: true }, { key: 'essentials', label: 'Essentials only', current: false }],
  impact: { blocks: 4, planned_minutes: 240, tasks_scheduled: 2, tasks_unscheduled: 1, busiest_day: null },
}
const proposal = { id: '11111111-2222-4333-8444-555555555555', kind: 'plan_week', provider: 'local', status: 'pending' as const, summary: 'Suggested 1 block(s).', explanation: [], actions: [{ id: 'a1', type: 'create_event' as const, title: 'Thesis', starts_at: '2027-01-05T09:00:00Z', ends_at: '2027-01-05T10:00:00Z', minutes: 60, task_id: 3 }], results: null, expires_at: '2027-01-05T10:00:00Z', applied_at: null }
const assistant = (over: Partial<CopilotMessage> = {}): CopilotMessage => ({ id: 2, role: 'assistant', content: 'Suggested 1 block(s).', intent: 'plan_week', provider: 'local', created_at: at, plan, proposal, state: undefined, context: { shared: false, sources: [{ source: 'tasks' }, { source: 'calendar' }] }, ...over } as CopilotMessage)
beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals() })

describe('server-sent events', () => {
  it('parses complete events and keeps the unfinished remainder', () => {
    const { events, rest } = parseEvents('event: stage\ndata: {"stage":"received"}\n\nevent: stage\ndata: {"stage":"plan')
    expect(events).toEqual([{ event: 'stage', data: { stage: 'received' } }])
    expect(rest).toBe('event: stage\ndata: {"stage":"plan')
    expect(parseEvents('event: stage\ndata: not json\n\n').events).toEqual([])
  })

  it('reports real stages and returns only the final validated answer', async () => {
    const chunks = ['event: stage\ndata: {"stage":"received"}\n\nevent: st', 'age\ndata: {"stage":"planning"}\n\n', `event: done\ndata: ${JSON.stringify({ conversation, user_message: { id: 1 }, message: { id: 2 }, replayed: false })}\n\n`]
    const stream = new ReadableStream({ start(c) { for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk)); c.close() } })
    const fetcher = vi.fn(async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetcher)
    const stages: string[] = []
    const result = await sendCopilot({ language: 'en', message: 'hi', client_id: 'c1' }, s => stages.push(s))
    expect(stages).toEqual(['received', 'planning'])
    expect(result.message.id).toBe(2)
    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>).Accept).toContain('text/event-stream')
  })

  it('turns a streamed error into a readable failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('event: error\ndata: {"status":404,"message":"Conversation not found."}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })))
    await expect(sendCopilot({ language: 'en', message: 'hi', client_id: 'c1' })).rejects.toMatchObject({ status: 404, message: 'Conversation not found.' })
  })
})

describe('plan card', () => {
  it('shows impact, conflicts and lets the user switch alternatives', () => {
    const choose = vi.fn()
    render(wrap(<PlanCard plan={plan} onAlternative={choose} />))
    expect(screen.getByText('New blocks').nextSibling?.textContent).toBe('4')
    expect(screen.getByText('4h')).toBeInTheDocument()
    expect(screen.getByText('Needs your attention')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Everything, by priority' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Essentials only' }))
    expect(choose).toHaveBeenCalledWith('essentials')
  })

  it('labels AI and rule-based answers and what data was shared', () => {
    render(wrap(<><SourceBadge provider="anthropic" /><SourceBadge provider="local" /><ContextChips provider="anthropic" context={{ shared: true, sources: [{ source: 'calendar', count: 5, masked: 2 }] }} /></>))
    expect(screen.getByText(/AI · Claude/)).toBeInTheDocument()
    expect(screen.getByText(/Rule-based · Local assistant/)).toBeInTheDocument()
    expect(screen.getByText('Shared with Claude:')).toBeInTheDocument()
    expect(screen.getByText(/Calendar · 5/)).toBeInTheDocument()
    expect(screen.getByTitle('Connected events shared only as “Busy”')).toBeInTheDocument()
  })
})

describe('copilot workspace', () => {
  const list = { match: /\/api\/copilot\/conversations\?/, body: { conversations: [conversation], suggestions: ['Plan my next week around my meetings'], personalization: false, retention_days: 90 } }

  it('opens a conversation from history and sends a plan alternative as a choice', async () => {
    const asked = { id: 1, role: 'user', content: 'Plan my week', intent: null, provider: null, created_at: at }
    const fetcher = mockApi([user, list,
      { match: /\/api\/copilot\/conversations\/0d6c1f6e[^?]*$/, body: { conversation, messages: [asked, assistant()] } },
      { match: /\/api\/copilot\/messages$/, method: 'POST', body: { conversation, user_message: { ...asked, id: 3, content: 'Essentials only' }, message: assistant({ id: 4, content: 'Essentials version.' }), replayed: false } },
    ])
    render(wrap(<AssistantPage />))
    fireEvent.click(await screen.findByRole('button', { name: /^Plan my week/ }))
    expect(await screen.findByText('Plan for 4 Jan – 10 Jan')).toBeInTheDocument()
    expect(screen.getByText('Needs your approval')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Essentials only' }))
    expect(await screen.findByText('Essentials version.')).toBeInTheDocument()
    const call = fetcher.mock.calls.find(c => String(c[0]).endsWith('/api/copilot/messages'))!
    expect(JSON.parse(call[1]!.body as string)).toMatchObject({ conversation_id: conversation.id, choice: { type: 'alternative', message_id: 2, value: 'essentials' } })
  })

  it('answers a clarifying question with one of its options', async () => {
    const question = assistant({ id: 6, intent: 'prioritize', content: 'What should come first?', plan: null, proposal: null, clarify: { intent: 'prioritize', slot: 'priorities', options: [{ value: 'study', label: { en: 'Studying', ar: 'الدراسة' } }, { value: 'work', label: { en: 'Work', ar: 'العمل' } }] } })
    const fetcher = mockApi([user, list,
      { match: /\/api\/copilot\/conversations\/0d6c1f6e[^?]*$/, body: { conversation, messages: [question] } },
      { match: /\/api\/copilot\/messages$/, method: 'POST', body: { conversation, user_message: { id: 7, role: 'user', content: 'Studying', intent: null, provider: null, created_at: at }, message: assistant({ id: 8 }), replayed: false } },
    ])
    render(wrap(<AssistantPage />, `/assistant?c=${conversation.id}`))
    fireEvent.click(await screen.findByRole('button', { name: 'Studying' }))
    await waitFor(() => expect(fetcher.mock.calls.some(c => String(c[0]).endsWith('/api/copilot/messages'))).toBe(true))
    const call = fetcher.mock.calls.find(c => String(c[0]).endsWith('/api/copilot/messages'))!
    expect(JSON.parse(call[1]!.body as string).choice).toEqual({ type: 'option', message_id: 6, value: 'study' })
  })

  it('deletes a conversation only after confirmation and explains chat approval', async () => {
    const fetcher = mockApi([user, list, { match: /\/api\/copilot\/conversations\/0d6c1f6e/, method: 'DELETE', body: { deleted: 1 } }])
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    render(wrap(<AssistantPage />))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete “Plan my week”' }))
    expect(confirm).toHaveBeenCalled()
    expect(fetcher.mock.calls.some(c => c[1]?.method === 'DELETE')).toBe(false)
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Delete “Plan my week”' }))
    await waitFor(() => expect(fetcher.mock.calls.some(c => c[1]?.method === 'DELETE')).toBe(true))
    expect(screen.getByText(/saying “yes” in chat never applies anything/)).toBeInTheDocument()
    expect(screen.getByText(/Kept for 90 days/)).toBeInTheDocument()
  })

  it('renders the workspace in Arabic', async () => {
    localStorage.setItem('lifeos-language', 'ar')
    mockApi([user, { ...list, body: { ...list.body, suggestions: [] } }])
    render(wrap(<AssistantPage />))
    expect(await screen.findByRole('button', { name: 'محادثة جديدة' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'اعثر على ثلاث فترات تركيز دون نقل المواعيد الثابتة' })).toBeInTheDocument()
    expect(document.documentElement.dir).toBe('rtl')
  })
})
