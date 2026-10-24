
import { ChartNoAxesColumn } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useLanguage } from '../../contexts/LanguageContext'
import { weeklyProgress } from '../../data/dashboardMock'

export default function WeeklyProgress() {
  const { language } = useLanguage()
  const reduceMotion = useReducedMotion()
  const ar = language === 'ar'

  const maxMinutes = Math.max(
    1,
    ...weeklyProgress.map((day) => day.minutes)
  )

  const labels = ar
    ? ['إث', 'ثل', 'أر', 'خم', 'جم', 'سب', 'أح']
    : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

  const totalMinutes = weeklyProgress.reduce(
    (sum, day) => sum + day.minutes,
    0
  )

  return (
    <section className="lifeos-card p-6">
      <div className="mb-6 flex items-center gap-3">
        <ChartNoAxesColumn
          size={22}
          style={{ color: 'var(--color-primary)' }}
        />
        <h2 className="text-lg font-bold">
          {ar ? 'التقدم الأسبوعي' : 'Weekly progress'}
        </h2>
      </div>

      <div className="mb-6">
        <p className="text-3xl font-bold tabular-nums">
          {Math.floor(totalMinutes / 60)}h {totalMinutes % 60}m
        </p>
        <p
          className="mt-1 text-sm"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {ar ? 'إجمالي وقت التركيز التجريبي' : 'Sample total focus time'}
        </p>
      </div>

      <div className="flex h-44 items-end justify-between gap-3">
        {weeklyProgress.map((day, index) => (
          <div
            key={day.day}
            className="flex h-full min-w-0 flex-1 flex-col items-center gap-2"
          >
            <div className="flex w-full flex-1 items-end justify-center">
              <motion.div
                initial={reduceMotion ? false : { height: 0 }}
                animate={{
                  height: `${(day.minutes / maxMinutes) * 100}%`,
                }}
                transition={{
                  duration: 0.6,
                  delay: reduceMotion ? 0 : index * 0.06,
                }}
                className="w-full max-w-10 rounded-t-xl"
                style={{ background: 'var(--color-primary)' }}
                title={`${day.minutes} min`}
              />
            </div>

            <span
              className="text-xs"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {labels[index]}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
