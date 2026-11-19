import { Suspense } from 'react'
import { lazyPart } from '../../lib/lazyPart'
import { useUiPrefs } from '../../lib/uiPrefs'

// The first-run setup is its own chunk: only an account whose settings say «pending» ever downloads it.
const Setup = lazyPart(() => import('../../features/onboarding/FirstRunSetup').then(m => m.default))

/** Mounts the first-run setup while the account's setup is still pending; nothing at all for everyone else. */
export default function SetupHost() {
  const { onboarding } = useUiPrefs()
  return onboarding === 'pending' ? <Suspense fallback={null}><Setup /></Suspense> : null
}
