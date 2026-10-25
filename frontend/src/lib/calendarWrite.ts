export type WriteState = { available: boolean; granted: boolean; enabled: boolean; calendar_id: string | null; calendar_name: string | null; copies: number }
export type WriteTarget = { id: number; provider: string; email: string | null; calendar_name: string | null }
export type WriteLink = { id: number; account_id: number; event_id: number | null; title: string; starts_at: string; ends_at: string; orphan: boolean; in_sync: boolean }
export type WriteData = { enabled: boolean; targets: WriteTarget[]; links: WriteLink[] }
export type WriteOp = 'create' | 'update' | 'delete'
type Snapshot = { title: string; starts_at: string; ends_at: string }
export type WritePreview = { op: WriteOp; account: { id: number; provider: string; label: string; email: string | null }; calendar: { id: string | null; name: string | null }; before: Snapshot | null; after: Snapshot | null; token: string; expires_at: string }
