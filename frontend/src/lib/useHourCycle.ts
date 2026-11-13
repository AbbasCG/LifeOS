import { useEffect, useState } from 'react'
import { HOUR_CYCLE_CHANGED, preferredHourCycle, saveHourCycle, type HourCycle } from './dateTime'

/** The user's 12 or 24 hour setting (24 unless chosen otherwise), kept in step with the picker's own switch. */
export function useHourCycle(): [HourCycle, (next: HourCycle) => void] {
  const [cycle, setCycle] = useState<HourCycle>(() => preferredHourCycle())
  useEffect(() => {
    const sync = () => setCycle(preferredHourCycle())
    window.addEventListener(HOUR_CYCLE_CHANGED, sync)
    return () => window.removeEventListener(HOUR_CYCLE_CHANGED, sync)
  }, [])
  return [cycle, saveHourCycle]
}
