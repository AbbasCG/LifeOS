import { describe, expect, it } from 'vitest'
import { findConflict, overlappingIds } from '../lib/calendar'

const at = (h: number, m = 0) => new Date(2027, 1, 3, h, m).toISOString()
const block = (id: number, title: string, from: [number, number], to: [number, number], task_closed = false) => ({ id, title, starts_at: at(...from), ends_at: at(...to), task_closed })

describe('blocks of completed or cancelled tasks', () => {
  it('do not count as a conflict when dragging over them, but open blocks still do', () => {
    const items = [block(1, 'Done', [9, 0], [9, 30], true), block(2, 'Open', [10, 0], [10, 30])]
    expect(findConflict(items, undefined, new Date(at(9, 15)), new Date(at(9, 45)))).toBeUndefined()
    expect(findConflict(items, undefined, new Date(at(10, 15)), new Date(at(10, 45)))?.title).toBe('Open')
  })
  it('are left out of the "overlapping" count', () => {
    const items = [block(1, 'Done', [9, 0], [9, 30], true), block(2, 'New', [9, 15], [9, 45]), block(3, 'A', [11, 0], [11, 30]), block(4, 'B', [11, 15], [11, 45])]
    expect([...overlappingIds(items)].sort()).toEqual([3, 4])
  })
})
