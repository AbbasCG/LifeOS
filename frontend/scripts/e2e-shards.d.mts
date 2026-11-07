export const PROJECTS: string[]
export const DEFAULT_WEIGHT: number
export type Unit = { file: string; project: string; weight: number }
export type Shard = { units: Unit[]; seconds: number }
export function specFiles(dir?: string): string[]
export function loadWeights(file?: string): Record<string, number>
export function plan(total: number, files?: string[], weights?: Record<string, number>): Shard[]
export function shardEnv(index: number, total: number, files?: string[], weights?: Record<string, number>): { E2E_DESKTOP_FILES: string; E2E_MOBILE_FILES: string }
