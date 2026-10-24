
import { useEffect, useRef, useState } from 'react'
import { Pause, Play, RotateCcw, Timer } from 'lucide-react'
import { useLanguage } from '../../contexts/LanguageContext'

const DURATION = 25 * 60

export default function FocusWidget() {
  const { language } = useLanguage()
  const ar = language === 'ar'

  const [remaining, setRemaining] = useState(DURATION)
  const [running, setRunning] = useState(false)
  const deadline = useRef<number | null>(null)

  useEffect(() => {
    if (!running) return

    deadline.current = Date.now() + remaining * 1000

    const interval = window.setInterval(() => {
      if (deadline.current === null) return

      const next = Math.max(
        0,
        Math.ceil((deadline.current - Date.now()) / 1000)
      )

      setRemaining(next)

      if (next === 0) {
        setRunning(false)
      }
    }, 250)

    return () => window.clearInterval(interval)
  }, [running])

  const minutes = Math.floor(remaining / 60)
  const seconds = remaining % 60
  const progress = ((DURATION - remaining) / DURATION) * 100

  return (
    <section className="lifeos-card p-6">
      <div className="mb-6 flex items-center gap-3">
        <Timer size={22} style={{ color: 'var(--color-primary)' }} />
        <h2 className="text-lg font-bold">
          {ar ? 'جلسة التركيز' : 'Focus session'}
        </h2>
      </div>

      <div className="flex flex-col items-center">
        <div
          className="flex h-48 w-48 items-center justify-center rounded-full p-3"
          style={{
            background: `conic-gradient(
              var(--color-primary) ${progress}%,
              var(--color-surface-muted) ${progress}%
            )`,
          }}
        >
          <div
            className="flex h-full w-full flex-col items-center justify-center rounded-full"
            style={{ background: 'var(--color-surface)' }}
          >
            <span className="text-4xl font-bold tabular-nums" dir="ltr">
              {String(minutes).padStart(2, '0')}:
              {String(seconds).padStart(2, '0')}
            </span>
            <span
              className="mt-2 text-xs"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {ar ? 'جلسة تركيز' : 'Focus session'}
            </span>
          </div>
        </div>

        <div className="mt-7 flex gap-3">
          <button
            type="button"
            disabled={remaining === 0}
            onClick={() => setRunning((value) => !value)}
            className="flex items-center gap-2 rounded-xl px-5 py-3 font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--color-primary)' }}
          >
            {running ? <Pause size={18} /> : <Play size={18} />}
            {running
              ? ar ? 'إيقاف مؤقت' : 'Pause'
              : ar ? 'ابدأ التركيز' : 'Start focus'}
          </button>

          <button
            type="button"
            onClick={() => {
              setRunning(false)
              setRemaining(DURATION)
            }}
            className="rounded-xl border p-3"
            style={{ borderColor: 'var(--color-border)' }}
            aria-label={ar ? 'إعادة ضبط المؤقت' : 'Reset timer'}
          >
            <RotateCcw size={18} />
          </button>
        </div>
      </div>
    </section>
  )
}
