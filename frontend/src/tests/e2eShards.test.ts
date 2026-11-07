import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_WEIGHT, PROJECTS, loadWeights, plan, shardEnv, specFiles } from '../../scripts/e2e-shards.mjs'

// Guards the CI split of the browser tests: if the plan could drop a spec file or a project, a whole slice of the suite would silently stop running.
const TOTAL = 6   // keep in step with the matrix in .github/workflows/ci.yml
const files = specFiles(), weights = loadWeights()

describe('CI browser-test shards', () => {
  it('the workflow matrix has as many shards as this plan assumes', () => {
    const ci = readFileSync(resolve(__dirname, '../../../.github/workflows/ci.yml'), 'utf8')
    const matrix = /shard:\s*\[([^\]]+)\]/.exec(ci)?.[1].split(',').map(s => Number(s.trim()))
    expect(matrix).toEqual(Array.from({ length: TOTAL }, (_, i) => i + 1))
  })

  it('assigns every (spec file, project) pair to exactly one shard', () => {
    const seen = new Map<string, number>()
    for (const shard of plan(TOTAL)) for (const u of shard.units) seen.set(`${u.file}|${u.project}`, (seen.get(`${u.file}|${u.project}`) ?? 0) + 1)
    for (const file of files) for (const project of PROJECTS) expect(seen.get(`${file}|${project}`), `${file} [${project}]`).toBe(1)
    expect(seen.size).toBe(files.length * PROJECTS.length)
  })

  it('every shard env lists only real spec files, and together they cover every file for every project', () => {
    const cover: Record<string, Set<string>> = { desktop: new Set(), mobile: new Set() }
    for (let i = 1; i <= TOTAL; i++) {
      const env = shardEnv(i, TOTAL)
      for (const [project, key] of [['desktop', 'E2E_DESKTOP_FILES'], ['mobile', 'E2E_MOBILE_FILES']] as const) {
        for (const f of env[key].split(',').filter(Boolean)) { expect(files).toContain(f); expect(cover[project].has(f), `${f} twice in ${project}`).toBe(false); cover[project].add(f) }
      }
    }
    for (const project of PROJECTS) expect([...cover[project]].sort()).toEqual([...files].sort())
  })

  it('a new spec file with no recorded weight is still planned', () => {
    const withNew = [...files, 'brand-new.spec.ts']
    const all = plan(TOTAL, withNew, weights).flatMap(s => s.units)
    expect(all.filter(u => u.file === 'brand-new.spec.ts').map(u => u.weight)).toEqual([DEFAULT_WEIGHT, DEFAULT_WEIGHT])
  })

  it('is deterministic and balanced: the slowest shard is within one small unit of the average', () => {
    expect(plan(TOTAL)).toEqual(plan(TOTAL))
    const seconds = plan(TOTAL).map(s => s.seconds), mean = seconds.reduce((a, b) => a + b, 0) / TOTAL
    expect(Math.max(...seconds)).toBeLessThanOrEqual(mean * 1.1 + 5)
    expect(Math.min(...seconds)).toBeGreaterThan(mean * 0.8)
  })

  it('rejects an impossible shard number instead of running nothing', () => {
    expect(() => shardEnv(0, TOTAL)).toThrow()
    expect(() => shardEnv(TOTAL + 1, TOTAL)).toThrow()
    expect(() => plan(0)).toThrow()
  })

  it('the weights file only names spec files that still exist', () => {
    for (const key of Object.keys(weights)) expect(files, key).toContain(key.split('|')[0])
  })
})
