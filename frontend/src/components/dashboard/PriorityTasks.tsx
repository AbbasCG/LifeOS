
import { CheckCircle2, Circle, ListTodo } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useLanguage } from '../../contexts/LanguageContext'
import type { DashboardTask } from '../../types/dashboard'

type PriorityTasksProps = {
  tasks: DashboardTask[]
  onToggle: (id: number) => void
}

export default function PriorityTasks({
  tasks,
  onToggle,
}: PriorityTasksProps) {
  const { language } = useLanguage()
  const reduceMotion = useReducedMotion()
  const ar = language === 'ar'

  const completedCount = tasks.filter((task) => task.completed).length

  return (
    <section className="lifeos-card p-6">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ListTodo
            size={22}
            style={{ color: 'var(--color-primary)' }}
          />
          <h2 className="text-lg font-bold">
            {ar ? 'أولويات اليوم' : "Today's priorities"}
          </h2>
        </div>

        <span
          className="text-sm tabular-nums"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {completedCount}/{tasks.length}
        </span>
      </div>

      <div className="space-y-3">
        {tasks.map((task) => (
          <motion.button
            key={task.id}
            type="button"
            whileHover={reduceMotion ? undefined : { scale: 1.01 }}
            whileTap={reduceMotion ? undefined : { scale: 0.99 }}
            onClick={() => onToggle(task.id)}
            aria-pressed={task.completed}
            className="flex w-full items-center gap-4 rounded-2xl border p-4 text-start transition-colors"
            style={{
              borderColor: 'var(--color-border)',
              background: 'var(--color-surface-muted)',
            }}
          >
            {task.completed ? (
              <CheckCircle2
                size={23}
                className="shrink-0 text-emerald-500"
              />
            ) : (
              <Circle
                size={23}
                className="shrink-0"
                style={{ color: 'var(--color-text-muted)' }}
              />
            )}

            <div className="min-w-0 flex-1">
              <p
                className={`font-semibold ${
                  task.completed ? 'line-through opacity-50' : ''
                }`}
              >
                {task.title[language]}
              </p>

              <p
                className="mt-1 text-xs"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {task.category[language]} · {task.estimatedMinutes} min
              </p>
            </div>

            <span
              aria-label={
                task.priority === 'high'
                  ? ar ? 'أولوية عالية' : 'High priority'
                  : task.priority === 'medium'
                    ? ar ? 'أولوية متوسطة' : 'Medium priority'
                    : ar ? 'أولوية منخفضة' : 'Low priority'
              }
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                task.priority === 'high'
                  ? 'bg-rose-500'
                  : task.priority === 'medium'
                    ? 'bg-amber-500'
                    : 'bg-emerald-500'
              }`}
            />
          </motion.button>
        ))}
      </div>
    </section>
  )
}
