import { api } from './api'

export type SyncDirection = 'inbound' | 'outbound' | 'two_way' | 'manual'
export type ConflictPolicy = 'ask' | 'prefer_lifeos' | 'prefer_external' | 'keep_both'
export const DIRECTIONS: SyncDirection[] = ['inbound', 'outbound', 'two_way', 'manual']
export const POLICIES: ConflictPolicy[] = ['ask', 'prefer_external', 'prefer_lifeos', 'keep_both']
export type OutboundRun = { id: number; status: 'running' | 'success' | 'partial' | 'failed' | 'rate_limited' | 'revoked'; started_at: string; upserted: number; error: string | null; details: { pushed?: number; conflicts?: number; awaiting?: number; gone?: number; failed?: number; pending?: number } }
/** Everything shown about how one connection is synchronised. Only facts the server can prove from its database. */
export type SyncState = {
  direction: SyncDirection; effective_direction: SyncDirection; effective_reason: 'permissions' | 'unsupported' | null; available_directions: SyncDirection[]
  conflict_policy: ConflictPolicy; paused: boolean; paused_at: string | null; copies: number; copies_pending: number; open_conflicts: number; last_outbound: OutboundRun | null
}
export type PushResult = { ran: boolean; reason: string | null; pushed: number; conflicts: number; awaiting: number; gone: number; failed: number; pending: number; planned: { link_id: number; from: string; to: string }[] }
export type Conflict = { id: number; account_id: number; status: 'open' | 'resolved'; resolution: string | null; title: string | null; starts_at: string | null; ends_at: string | null; detected_at: string | null }
export type Resolution = 'keep_external' | 'keep_lifeos' | 'keep_both'

export const saveSync = (accountId: number, body: { direction?: SyncDirection; conflict_policy?: ConflictPolicy; paused?: boolean }) => api<{ data: SyncState }>(`/api/integrations/accounts/${accountId}/sync-settings`, 'PUT', body)
export const previewPush = (accountId: number) => api<{ data: PushResult }>(`/api/integrations/accounts/${accountId}/sync/preview`, 'POST').then(r => r.data)
export const pushNow = (accountId: number) => api<{ data: PushResult }>(`/api/integrations/accounts/${accountId}/sync/push`, 'POST').then(r => r.data)
export const loadConflicts = (accountId: number) => api<{ data: Conflict[] }>(`/api/integrations/accounts/${accountId}/sync-conflicts`).then(r => r.data)
export const resolveConflict = (id: number, resolution: Resolution, confirmOverwrite: boolean) =>
  api(`/api/integrations/sync-conflicts/${id}/resolve`, 'POST', { resolution, ...(confirmOverwrite ? { confirm_overwrite: true } : {}) })
