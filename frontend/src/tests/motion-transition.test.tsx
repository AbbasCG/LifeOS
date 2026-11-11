import { afterEach, describe, expect, it, vi } from 'vitest'
import { prefersReducedMotion, withTransition } from '../lib/viewTransition'

const realMatchMedia = window.matchMedia
const setStart = (value?: unknown) => { Object.defineProperty(document, 'startViewTransition', { value, configurable: true, writable: true }) }
const reduce = (on: boolean) => { window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: on && query.includes('reduce') })) as unknown as typeof window.matchMedia }

describe('withTransition', () => {
  afterEach(() => { window.matchMedia = realMatchMedia; setStart(undefined) })

  it('runs the update directly when View Transitions are not supported', () => {
    const update = vi.fn()
    withTransition(update)
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('runs the update inside startViewTransition when supported', () => {
    const start = vi.fn((cb: () => void) => { cb(); return {} })
    setStart(start)
    const update = vi.fn()
    withTransition(update)
    expect(start).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('skips the transition entirely under reduced motion', () => {
    reduce(true)
    const start = vi.fn()
    setStart(start)
    const update = vi.fn()
    withTransition(update)
    expect(start).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('still updates once if the browser throws when starting a transition', () => {
    setStart(() => { throw new Error('nope') })
    const update = vi.fn()
    withTransition(update)
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('reads the reduced-motion preference at call time', () => {
    reduce(false); expect(prefersReducedMotion()).toBe(false)
    reduce(true); expect(prefersReducedMotion()).toBe(true)
  })
})
