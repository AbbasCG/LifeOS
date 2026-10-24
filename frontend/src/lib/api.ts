export class ApiError extends Error {
  status: number
  errors: Record<string, string[]>
  constructor(status: number, message: string, errors: Record<string, string[]> = {}) { super(message); this.status = status; this.errors = errors }
}
const base = import.meta.env.VITE_API_BASE_URL || ''
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const token = document.cookie.split('; ').find(v => v.startsWith('XSRF-TOKEN='))?.split('=').slice(1).join('=')
  const response = await fetch(`${base}${path}`, { method, credentials: 'include', headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-XSRF-TOKEN': decodeURIComponent(token) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) throw new ApiError(response.status, data?.message || `Request failed (${response.status})`, data?.errors)
  return data as T
}
export async function csrf() { await api('/sanctum/csrf-cookie') }
export type RecordItem = { id: number; title: string; description?: string; status?: string; priority?: string; category_id?: number | null; project_id?: number | null; task_id?: number | null; due_at?: string | null; starts_at?: string; ends_at?: string; estimated_minutes?: number; actual_minutes?: number; completed_at?: string | null; color?: string; target?: number; progress?: number; recurrence?: string; entries?: { date: string }[]; [key: string]: unknown }
export type Page<T> = { data: T[]; current_page: number; last_page: number; total: number }
