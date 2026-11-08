import { api } from './api'

/** Administrator-only management of the OAuth clients LifeOS uses to sign people in to Google, Microsoft and Todoist. The secret only ever goes up, never down. */
export type ProviderConfig = {
  provider: string
  name: { en: string; ar: string }
  docs_url: string | null
  scopes: { id: string; required: boolean; label: { en: string; ar: string } }[]
  configured: boolean
  source: 'database' | 'environment' | 'none'
  client_id: string | null
  has_secret: boolean
  redirect_uri: string | null
  suggested_redirect_uri: string
  rotated_at: string | null
  connections_allowed: boolean
  secret_unreadable: boolean
  updated_at: string | null
  updated_by: string | null
}
export type CheckId = 'client_id' | 'secret_readable' | 'redirect_matches' | 'sign_in_address' | 'connections_allowed'
export type TestResult = { provider: string; ok: boolean; checks: { id: CheckId; ok: boolean }[]; contacted_provider: boolean }
export type ConfigAudit = { id: number; action: string; at: string | null; actor: string | null; provider: string | null; secret_changed: boolean | null; ok: boolean | null }

export const credentialsPath = '/api/admin/integrations/credentials'
export const configAuditPath = '/api/admin/integrations/audit'
export const saveCredentials = (provider: string, body: { client_id: string; client_secret?: string; redirect_uri: string }) => api<{ data: ProviderConfig }>(`${credentialsPath}/${provider}`, 'PUT', body)
export const removeCredentials = (provider: string) => api<{ data: ProviderConfig }>(`${credentialsPath}/${provider}`, 'DELETE')
export const setProviderEnabled = (provider: string, enabled: boolean) => api<{ data: ProviderConfig }>(`${credentialsPath}/${provider}/enabled`, 'PATCH', { enabled })
export const testProvider = (provider: string) => api<{ data: TestResult }>(`${credentialsPath}/${provider}/test`, 'POST').then(r => r.data)
