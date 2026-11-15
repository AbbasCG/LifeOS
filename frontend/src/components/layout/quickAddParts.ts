import { lazyPart } from '../../lib/lazyPart'

// Loaded on demand, then fetched in the background once the page is idle so they also work offline.
export const VoiceButton = lazyPart(() => import('../../features/assistant/VoiceButton').then(m => m.VoiceButton))
// Only needed when a time turns out to be taken.
export const ScheduleConflictDialog = lazyPart(() => import('../ui/ScheduleConflictDialog').then(m => m.ScheduleConflictDialog))
export const RecordForm = lazyPart(() => import('../../features/ResourcePage').then(m => m.RecordForm))
/** Fetches the parts the sheet opens on demand (called by the shell once the page is idle, so they are cached for offline use). */
export function preloadSheetParts() { VoiceButton.preload(); RecordForm.preload(); ScheduleConflictDialog.preload() }
