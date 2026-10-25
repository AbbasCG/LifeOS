import type { AssistantProposal } from './api'

export type Bi = { en: string; ar: string }
export type Confidence = 'high' | 'medium' | 'low'
export type PriorityInsight = {
  id: number; title: string; priority: string; status: string; due_at: string | null; estimated_minutes: number; score: number; reasons: string[]
  risk: 'high' | 'medium' | 'low'; scheduled: boolean; postponed_count: number; confidence: Confidence; sources: string[]
}
export type RecAction = { kind: 'link'; to: string; label: Bi } | { kind: 'proposal'; proposal: 'find_time' | 'rebalance'; task_ids?: number[]; label: Bi }
export type Recommendation = {
  id: number; type: 'deadline' | 'conflict' | 'overload' | 'goal' | 'postponed' | 'focus'; severity: 'high' | 'medium' | 'low'; status: string; feedback: 'useful' | 'not_useful' | null
  title: Bi; detail: Bi; confidence: Confidence; sources: string[]; evidence: Record<string, unknown>; action: RecAction | null; proposal_id: string | null; first_seen_at: string
}
export type FocusWindow = { area: string; starts_at: string; ends_at: string; minutes: number }
export type FocusCapacity = { minutes: number; free_minutes: number; typical_daily_minutes: number | null; daily_limit: number | null; basis: { sessions: number; days: number; window_days: number }; confidence: Confidence; sources: string[] }
export type MorningBriefing = { enabled: false } | {
  enabled: true; generated_at: string; date: string; timezone: string; sources: string[]
  priorities: PriorityInsight[]; meetings: { title: string; starts_at: string; ends_at: string; source: string }[]; deadlines: PriorityInsight[]
  focus: { windows: FocusWindow[]; capacity: FocusCapacity }
  overloaded: { date: string; load_percent: number; committed_minutes: number; capacity_minutes: number }[]
  unfinished: { id: number; title: string; idle_days?: number; postponed_count?: number; postponed?: boolean }[]
  improvements: (Bi & { key: string; sources: string[] })[]
  suggestions: Recommendation[]
}
export type IntelligencePrefs = {
  enabled: boolean; features: Record<'briefing' | 'recommendations' | 'weekly' | 'planner' | 'ai_narrative', boolean>
  sources: Record<'calendar' | 'connected' | 'goals' | 'habits' | 'focus' | 'checkins', boolean>
  frequency: 'off' | 'quiet' | 'daily'; personalization: boolean; retention_days: number; planning_strategy: null | 'balanced' | 'deep' | 'light' | 'deadlines'
}
export type IntelligenceSettingsData = {
  settings: IntelligencePrefs
  options: { retention_days: number[]; strategies: string[] }
  external_ai: { allowed: boolean; connected_data: boolean; provider: { label: string; model: string } | null; in_use: boolean }
  counts: { recommendations: number; feedback: number; proposals: number }
}
export type AiActivity = {
  proposals: { id: string; kind: string; provider: string; status: string; summary: string; actions: number; created_at: string; applied_at: string | null }[]
  recommendations: Recommendation[]
  events: { action: string; at: string; meta: Record<string, unknown> }[]
}
export type WeeklyFact = { key: string; value: number | null; unit: string; source: string; previous?: number; change_percent?: number | null }
export type WeeklyIntelligenceData = { enabled: false } | {
  enabled: true; facts: WeeklyFact[]; narrative_available: boolean
  interpretations: (Bi & { key: string; evidence: string[]; confidence: Confidence; kind: 'rule' })[]
  workload: { date: string; committed_minutes: number; capacity_minutes: number; load_percent: number; focus_minutes: number; completed: number }[]
  suggestions: (Bi & { key: string; link: string | null })[]
}
export type Narrative = { kind: 'ai' | 'rules'; text: string; provider?: string; fallback_reason?: 'disabled' | 'not_available' | 'provider_error' }
export type ActResult = AssistantProposal
