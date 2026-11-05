import type { Plugin } from 'vite'
export const FONT_URL_PREFIX: string
export const FONT_FILES: string[]
export function fontFolder(fontsRoot: string): string | null
export function findFont(fontsRoot: string, fileName: string): string | null
export function fontReport(fontsRoot: string, wanted: string[]): { folder: string | null; found: string[]; missing: string[] }
export function thmanyahFonts(publicDir?: string): Plugin
