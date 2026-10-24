
import { CalendarDays, Clock3 } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useLanguage } from '../../contexts/LanguageContext'
import { timelineEvents } from '../../data/dashboardMock'

export default function TodayTimeline() {
  const { language } = useLanguage()
  const reduceMotion = useReducedMotion()
  const ar = language === 'ar'

  return (
    <section className="lifeos-card p-6">
      <div className="mb-6 flex items-center gap-3">
        <CalendarDays
          size={22}
          style={{ color: 'var(--color-primary)' }}
        />
        <h2 className="text-lg font-bold">
          {ar ? 'الجدول الزمني لليوم' : "Today's timeline"}
        </h2>
      </div>

      <div className="space-y-4">
        {timelineEvents.map((event, index) => (
          <motion.div
            key={event.id}
            initial={reduceMotion ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.08 }}
            className="flex items-start gap-4"
          >
            <div
              className="flex w-16 shrink-0 items-center gap-1 pt-3 text-sm"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <Clock3 size={14} />
              <span dir="ltr">{event.time}</span>
            </div>

            <div
              className="flex-1 rounded-2xl border-s-4 p-4"
              style={{
                borderColor:
                  event.type === 'fixed'
                    ? 'var(--color-primary)'
                    : 'var(--color-accent)',
                background: 'var(--color-surface-muted)',
              }}
            >
              <p className="font-semibold">
                {event.title[language]}
              </p>

              <p
                className="mt-1 text-xs"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {event.type === 'fixed'
                  ? ar ? 'موعد ثابت' : 'Fixed event'
                  : ar ? 'وقت مرن' : 'Flexible block'}
              </p>
            </div>
          </motion.div>
        ))}
      </div>
    </section>
  )
}
