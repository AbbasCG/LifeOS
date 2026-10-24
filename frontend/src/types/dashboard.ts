
export type LocalizedText = {
  ar: string
  en: string
}

export type DashboardTask = {
  id: number
  title: LocalizedText
  category: LocalizedText
  completed: boolean
  priority: 'high' | 'medium' | 'low'
  estimatedMinutes: number
}

export type TimelineEvent = {
  id: number
  time: string
  title: LocalizedText
  type: 'fixed' | 'flexible'
}

export type WeeklyDay = {
  day: string
  minutes: number
}
