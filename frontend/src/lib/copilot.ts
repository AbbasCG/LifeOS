import { ApiError, type AssistantProposal, type AssistantReply } from './api'

/** A source of data the Copilot used for an answer. `masked` counts connected events shared only as "Busy". */
export type ContextSource = { source: string; count?: number; masked?: number }
export type CopilotContext = { shared: boolean; sources: ContextSource[] }
export type PlanConflict = { type: 'unscheduled' | 'overloaded' | 'not_enough_time' | string; title: string; detail: string; minutes: number | null }
export type PlanAlternative = { key: string; label: string; current: boolean; planned_minutes?: number }
export type CopilotPlan = { kind: string; title: string; explanation: string[]; conflicts: PlanConflict[]; alternatives: PlanAlternative[]; impact: Record<string, number | null | { date: string; load_percent: number }>; moves?: PlanMoves }
/** Whether a plan may move flexible blocks: `available` is how many it would move when allowed. */
export type PlanMoves = { allowed: boolean; count: number; available: number }
export type ClarifyOption = { value: string; label: { en: string; ar: string } }
export type CopilotMessage = Partial<Omit<AssistantReply, 'message' | 'suggestions' | 'intent' | 'provider' | 'proposal' | 'notice'>> & {
  id: number; role: 'user' | 'assistant'; content: string; intent: string | null; provider: string | null; created_at: string
  proposal?: AssistantProposal | null; plan?: CopilotPlan | null; clarify?: { intent: string | null; slot: string; options: ClarifyOption[] } | null; context?: CopilotContext; notice?: string
}
export type Conversation = { id: string; title: string; language: 'en' | 'ar'; last_message_at: string; created_at: string }
export type ConversationList = { conversations: Conversation[]; suggestions: string[]; personalization: boolean; retention_days: number }
export type SendResult = { conversation: Conversation; user_message: CopilotMessage; message: CopilotMessage; replayed: boolean }
export type Choice = { type: 'option' | 'alternative'; message_id: number; value: string }
export type Stage = 'received' | 'context' | 'provider' | 'validating' | 'planning' | 'fallback' | 'saving'

const base = import.meta.env.VITE_API_BASE_URL || ''

/** A client id per message, so a retried request is answered once. */
export function clientId(): string {
  const c = globalThis.crypto
  return c?.randomUUID ? c.randomUUID() : `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
}

/** Parse complete server-sent events from a buffer; returns the parsed events and the unfinished remainder. */
export function parseEvents(buffer: string): { events: { event: string; data: unknown }[]; rest: string } {
  const blocks = buffer.split('\n\n'), rest = blocks.pop() ?? '', events: { event: string; data: unknown }[] = []
  for (const block of blocks) {
    let event = 'message', data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (!data) continue
    try { events.push({ event, data: JSON.parse(data) }) } catch { /* ignore a malformed event */ }
  }
  return { events, rest }
}

/**
 * Send a Copilot message. When the server streams, `onStage` receives the real processing stages; the answer itself
 * arrives only once it has been validated on the server. Falls back to a plain JSON response transparently.
 */
export async function sendCopilot(body: { conversation_id?: string | null; message?: string; language: string; client_id: string; choice?: Choice }, onStage?: (stage: Stage) => void): Promise<SendResult> {
  const token = document.cookie.split('; ').find(v => v.startsWith('XSRF-TOKEN='))?.split('=').slice(1).join('=')
  let response: Response
  try {
    response = await fetch(`${base}/api/copilot/messages`, { method: 'POST', credentials: 'include', headers: { Accept: 'text/event-stream, application/json', 'Content-Type': 'application/json', ...(token ? { 'X-XSRF-TOKEN': decodeURIComponent(token) } : {}) }, body: JSON.stringify(body) })
  } catch {
    const ar = document.documentElement.lang === 'ar'
    throw new ApiError(0, ar ? 'تعذر الوصول إلى LifeOS. تحقق من اتصالك وحاول مجدداً.' : 'Could not reach LifeOS. Check your connection and try again.')
  }
  const streamed = (response.headers.get('Content-Type') ?? '').includes('text/event-stream')
  if (!streamed || !response.body) {
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new ApiError(response.status, data?.message || `Request failed (${response.status})`, data?.errors)
    return data as SendResult
  }
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const parsed = parseEvents(done ? `${buffer}\n\n` : buffer)
    buffer = parsed.rest
    for (const { event, data } of parsed.events) {
      if (event === 'stage') onStage?.((data as { stage: Stage }).stage)
      if (event === 'done') return data as SendResult
      if (event === 'error') { const e = data as { status: number; message: string }; throw new ApiError(e.status, e.message) }
    }
    if (done) throw new ApiError(503, 'The assistant did not finish answering. Your data has not been changed.')
  }
}
