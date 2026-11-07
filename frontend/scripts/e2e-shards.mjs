#!/usr/bin/env node
/**
 * Splits the Playwright suite across CI shards by measured duration, so the browser tests finish in minutes instead of half an hour.
 *
 * Why not `playwright test --shard`: it balances by test COUNT, and one file (the accessibility scans) is ~25% of the total time.
 * Why not more workers on one runner: all tests share one demo account and one single-threaded PHP server (see playwright.config.ts).
 * Separate runners each get their own database and server, so every shard stays serial inside and independent outside.
 *
 * A unit is one (spec file, project) pair. Units are assigned greedily, heaviest first, to the least-loaded shard (deterministic).
 * Every spec file found in e2e/ is planned: a new file with no recorded weight gets a default weight, so it can never be skipped by accident.
 *
 *   node scripts/e2e-shards.mjs env <shard> <total>   → E2E_DESKTOP_FILES=… / E2E_MOBILE_FILES=… (append to $GITHUB_ENV)
 *   node scripts/e2e-shards.mjs plan <total>          → human-readable plan with expected seconds
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECTS = ['desktop', 'mobile']
export const DEFAULT_WEIGHT = 20

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function specFiles(dir = resolve(root, 'e2e')) {
  return readdirSync(dir).filter(f => f.endsWith('.spec.ts')).sort()
}
export function loadWeights(file = resolve(root, 'e2e/shard-weights.json')) {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_')))
}

/** Returns `total` shards: [{ units: [{ file, project, weight }], seconds }], balanced by weight. */
export function plan(total, files = specFiles(), weights = loadWeights()) {
  if (!Number.isInteger(total) || total < 1) throw new Error(`shard count must be a positive integer, got ${total}`)
  const units = files.flatMap(file => PROJECTS.map(project => ({ file, project, weight: weights[`${file}|${project}`] ?? DEFAULT_WEIGHT })))
    .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file) || a.project.localeCompare(b.project))
  const shards = Array.from({ length: total }, () => ({ units: [], seconds: 0 }))
  for (const unit of units) {
    const target = shards.reduce((best, s) => (s.seconds < best.seconds ? s : best))
    target.units.push(unit); target.seconds += unit.weight
  }
  return shards
}

/** The environment a shard runs with: which spec files each Playwright project may run (see playwright.config.ts). */
export function shardEnv(index, total, files = specFiles(), weights = loadWeights()) {
  if (!Number.isInteger(index) || index < 1 || index > total) throw new Error(`shard must be 1..${total}, got ${index}`)
  const shard = plan(total, files, weights)[index - 1]
  const pick = project => shard.units.filter(u => u.project === project).map(u => u.file).sort().join(',')
  return { E2E_DESKTOP_FILES: pick('desktop'), E2E_MOBILE_FILES: pick('mobile') }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, a, b] = process.argv.slice(2)
  try {
    if (command === 'env') {
      const env = shardEnv(Number(a), Number(b))
      for (const [k, v] of Object.entries(env)) console.log(`${k}=${v}`)
    } else if (command === 'plan') {
      const total = Number(a), shards = plan(total)
      shards.forEach((s, i) => console.log(`shard ${i + 1}/${total}: ${Math.round(s.seconds)}s (local, serial)\n  ` + s.units.map(u => `${u.file}[${u.project}] ${Math.round(u.weight)}s`).join('\n  ')))
    } else { console.error('usage: e2e-shards.mjs env <shard> <total> | plan <total>'); process.exit(2) }
  } catch (e) { console.error(String(e.message ?? e)); process.exit(1) }
}
