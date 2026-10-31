import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { api } from '../lib/api'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('identical reads at the same moment share one request', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => json({ timezone: 'Europe/Amsterdam', list: [1, 2] }))) })
  afterEach(() => vi.unstubAllGlobals())

  it('asks the server once, and each caller gets its own copy', async () => {
    const [a, b] = await Promise.all([api<{ list: number[] }>('/api/settings'), api<{ list: number[] }>('/api/settings')])
    expect(fetch).toHaveBeenCalledTimes(1)
    a.list.push(3)
    expect(b.list).toEqual([1, 2])
  })

  it('never reuses an answer after it has arrived', async () => {
    await api('/api/settings')
    await api('/api/settings')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not share different paths or anything that writes', async () => {
    await Promise.all([api('/api/settings'), api('/api/today'), api('/api/settings', 'PUT', { a: 1 }), api('/api/settings', 'PUT', { a: 1 })])
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('shares a failure with everyone who asked, and the next read tries again', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ message: 'Nope' }, 500))
    const both = await Promise.allSettled([api('/api/settings'), api('/api/settings')])
    expect(both.map(r => r.status)).toEqual(['rejected', 'rejected'])
    expect(fetch).toHaveBeenCalledTimes(1)
    await expect(api('/api/settings')).resolves.toMatchObject({ timezone: 'Europe/Amsterdam' })
  })
})
