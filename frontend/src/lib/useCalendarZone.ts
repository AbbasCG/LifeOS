import { useMemo, useState } from 'react'
import { accountZone } from './accountDay'
import { makeShift, zonesDiffer, type ZoneShift } from './zoneShift'

export type ZoneMode = 'account' | 'device'
const KEY = 'lifeos-calendar-zone'

const read = (): ZoneMode => { try { return localStorage.getItem(KEY) === 'device' ? 'device' : 'account' } catch { return 'account' } }

/**
 * Which timezone the calendar is drawn in (V29): the account's own (the one Today, the planner and the server use) or
 * the device's. The choice only matters when the two differ, so the switch is offered only then; it is remembered on
 * this device. Without a difference nothing is shifted.
 */
export function useCalendarZone(): { shift: ZoneShift; mode: ZoneMode; setMode: (mode: ZoneMode) => void; differs: boolean; accountZone?: string } {
  const [mode, setModeState] = useState<ZoneMode>(read)
  const account = accountZone()
  const differs = zonesDiffer(account)
  const zone = differs && mode === 'account' ? account : undefined
  const shift = useMemo(() => makeShift(zone), [zone])
  const setMode = (next: ZoneMode) => { setModeState(next); try { localStorage.setItem(KEY, next) } catch { /* storage unavailable */ } }
  return { shift, mode, setMode, differs, accountZone: account }
}
