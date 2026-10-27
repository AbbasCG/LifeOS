import { useEffect, useState } from 'react'
import { api, ApiError, type RecordItem } from './api'

/**
 * Offline capture (V23). Three small actions can be kept on this device while there is no connection: adding a task,
 * completing a task and logging a habit. They wait in a queue that belongs to the signed-in user and is sent only
 * when the user reviews it and taps Send. Nothing is overwritten silently: a task that was deleted or changed on
 * the server in the meantime becomes a conflict for the user to decide.
 */
export type PendingKind = 'task.create' | 'task.complete' | 'habit.log'
export type Pending = {
  id: string; kind: PendingKind; label: string; created_at: string
  /** task.create: the new task (with its client_id); task.complete: { task_id }; habit.log: { habit_id, date, completed }. */
  payload: Record<string, unknown>
  /** For task.complete: the task's updated_at when it was completed offline, to notice later changes. */
  base?: string | null
  state: 'waiting' | 'conflict'
  reason?: 'changed' | 'deleted' | 'rejected'
  message?: string
}
export type SendResult = 'sent' | 'already' | 'conflict' | 'offline'

export const OFFLINE_CHANGED = 'lifeos:offline-changed'
/** Ask the app shell to open "Waiting to sync". */
export const OPEN_SYNC = 'lifeos:open-sync'
export const openSync = () => window.dispatchEvent(new Event(OPEN_SYNC))
let owner: number | null = null
const key = () => owner === null ? null : `lifeos-offline-${owner}`

/** The queue belongs to one account; switching accounts on a device never shows or sends another person's items. */
export function setOfflineOwner(userId: number | null) {
  if (owner === userId) return
  owner = userId
  window.dispatchEvent(new Event(OFFLINE_CHANGED))
}

export function pendingItems(): Pending[] {
  const k = key()
  if (!k) return []
  try { const list = JSON.parse(localStorage.getItem(k) ?? '[]'); return Array.isArray(list) ? list : [] } catch { return [] }
}
function save(list: Pending[]) {
  const k = key()
  if (!k) return
  try { if (list.length) localStorage.setItem(k, JSON.stringify(list)); else localStorage.removeItem(k) } catch { /* storage full or blocked */ }
  window.dispatchEvent(new Event(OFFLINE_CHANGED))
}
const uuid = () => crypto.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`

export function enqueue(item: Pick<Pending, 'kind' | 'label' | 'payload' | 'base'>) {
  // Never drop something silently: without a known account there is nowhere safe to keep it.
  if (!key()) throw new Error('Sign in again to keep changes on this device.')
  save([...pendingItems(), { ...item, id: uuid(), created_at: new Date().toISOString(), state: 'waiting' }])
}
export const discard = (id: string) => save(pendingItems().filter(i => i.id !== id))
export const clearQueue = () => save([])

/** No connection: the browser says so, or a request could not reach the server at all. */
export const isOffline = (e?: unknown) => (typeof navigator !== 'undefined' && navigator.onLine === false) || (e instanceof ApiError && e.status === 0)

/** Re-render when the queue changes here or in another tab. */
export function usePending() {
  const [items, setItems] = useState(pendingItems)
  useEffect(() => {
    const update = () => setItems(pendingItems())
    window.addEventListener(OFFLINE_CHANGED, update); window.addEventListener('storage', update)
    return () => { window.removeEventListener(OFFLINE_CHANGED, update); window.removeEventListener('storage', update) }
  }, [])
  return items
}

/** Add a task now, or keep it on this device when offline. The client_id makes a repeated send harmless. */
export async function createTaskOrQueue(task: Partial<RecordItem>): Promise<'created' | 'queued'> {
  const payload = { ...task, client_id: uuid() }
  if (isOffline()) { enqueue({ kind: 'task.create', label: String(task.title ?? ''), payload }); return 'queued' }
  try { await api('/api/tasks', 'POST', payload); return 'created' } catch (e) {
    if (!isOffline(e)) throw e
    enqueue({ kind: 'task.create', label: String(task.title ?? ''), payload }); return 'queued'
  }
}

/** Complete a task now, or keep the completion on this device when offline. */
export async function completeTaskOrQueue(task: { id: number; title: string; updated_at?: string | null }): Promise<'done' | 'queued'> {
  const queue = () => { enqueue({ kind: 'task.complete', label: task.title, payload: { task_id: task.id }, base: task.updated_at ?? null }); return 'queued' as const }
  if (isOffline()) return queue()
  try { await api(`/api/tasks/${task.id}`, 'PATCH', { status: 'completed' }); return 'done' } catch (e) { if (!isOffline(e)) throw e; return queue() }
}

/** Log (or unlog) a habit now, or keep it on this device when offline. */
export async function logHabitOrQueue(habit: { id: number; title: string }, date: string, completed: boolean): Promise<'done' | 'queued'> {
  const queue = () => { enqueue({ kind: 'habit.log', label: habit.title, payload: { habit_id: habit.id, date, completed } }); return 'queued' as const }
  if (isOffline()) return queue()
  try { await api(`/api/habits/${habit.id}/entry`, 'PUT', { date, completed }); return 'done' } catch (e) { if (!isOffline(e)) throw e; return queue() }
}

const notFound = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 403)

/**
 * Send one queued item. `force` sends a completion even though the task changed elsewhere (the user decided).
 * Returns 'offline' and keeps the item when the connection drops again.
 */
export async function sendPending(item: Pending, force = false): Promise<SendResult> {
  const conflict = (reason: Pending['reason'], message?: string): SendResult => {
    save(pendingItems().map(i => i.id === item.id ? { ...i, state: 'conflict', reason, message } : i)); return 'conflict'
  }
  try {
    if (item.kind === 'task.create') {
      await api('/api/tasks', 'POST', item.payload)
    } else if (item.kind === 'habit.log') {
      const { habit_id, date, completed } = item.payload as { habit_id: number; date: string; completed: boolean }
      await api(`/api/habits/${habit_id}/entry`, 'PUT', { date, completed })
    } else {
      const id = Number(item.payload.task_id)
      if (!force) {
        const current = (await api<{ data: RecordItem }>(`/api/tasks/${id}`)).data
        if (current.status === 'completed') { discard(item.id); return 'already' }
        if (item.base && current.updated_at && current.updated_at !== item.base) return conflict('changed')
      }
      await api(`/api/tasks/${id}`, 'PATCH', { status: 'completed' })
    }
    discard(item.id)
    return 'sent'
  } catch (e) {
    if (isOffline(e)) return 'offline'
    if (notFound(e)) return conflict('deleted')
    return conflict('rejected', (e as Error).message)
  }
}

/** Send every waiting item, oldest first; conflicts stay for the user. Stops when the connection drops. */
export async function sendAllPending() {
  const summary = { sent: 0, already: 0, conflict: 0, offline: false }
  for (const item of pendingItems().filter(i => i.state === 'waiting')) {
    const result = await sendPending(item)
    if (result === 'offline') { summary.offline = true; break }
    if (result === 'sent') summary.sent++
    else if (result === 'already') summary.already++
    else summary.conflict++
  }
  return summary
}

/** Signing out deletes what was kept on this device for this account; ask first when something is waiting. */
export function confirmSignOut(question: (count: number) => string) {
  const count = pendingItems().length
  if (count && !window.confirm(question(count))) return false
  clearQueue()
  return true
}
