
import { useState } from 'react'

import WelcomeHeader from '../components/dashboard/WelcomeHeader'
import PriorityTasks from '../components/dashboard/PriorityTasks'
import TodayTimeline from '../components/dashboard/TodayTimeline'
import FocusWidget from '../components/dashboard/FocusWidget'
import WeeklyProgress from '../components/dashboard/WeeklyProgress'

import { initialTasks } from '../data/dashboardMock'

export default function DashboardPage() {
  const [tasks, setTasks] = useState(initialTasks)

  const toggleTask = (id: number) => {
    setTasks((current) =>
      current.map((task) =>
        task.id === id
          ? { ...task, completed: !task.completed }
          : task
      )
    )
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <WelcomeHeader />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <PriorityTasks tasks={tasks} onToggle={toggleTask} />
        <TodayTimeline />
        <FocusWidget />
        <WeeklyProgress />
      </div>
    </div>
  )
}
