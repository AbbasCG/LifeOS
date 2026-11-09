import { api } from './api'

/** What LifeOS itself may do with one connected account. The provider's own access (OAuth scopes) is a separate thing LifeOS cannot narrow. */
export type PermissionOp = 'read' | 'sync' | 'import' | 'export' | 'create' | 'update' | 'delete'
export type PermissionPreset = 'read_only' | 'read_create' | 'read_create_update' | 'full'
export const PRESET_ORDER: PermissionPreset[] = ['read_only', 'read_create', 'read_create_update', 'full']
export const PRESET_OPS: Record<PermissionPreset, PermissionOp[]> = {
  read_only: ['read', 'sync', 'import'],
  read_create: ['read', 'sync', 'import', 'export', 'create'],
  read_create_update: ['read', 'sync', 'import', 'export', 'create', 'update'],
  full: ['read', 'sync', 'import', 'export', 'create', 'update', 'delete'],
}
export type PermissionState = {
  granted: PermissionOp[]; effective: PermissionOp[]; capabilities: PermissionOp[]; presets: PermissionPreset[]; preset: PermissionPreset | null
  legacy: boolean; blocked: Partial<Record<PermissionOp, string>>; changed_at: string | null
}
export const savePermissions = (accountId: number, body: { preset: PermissionPreset } | { permissions: PermissionOp[] }, confirmDelete: boolean) =>
  api<{ data: PermissionState }>(`/api/integrations/accounts/${accountId}/permissions`, 'PUT', { ...body, ...(confirmDelete ? { confirm_delete: true } : {}) })
