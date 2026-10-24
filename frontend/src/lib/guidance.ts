import type { TodayData } from './api'

export type Guidance = { en: string; ar: string; ctaEn: string; ctaAr: string; to: string; tone: 'alert' | 'energy' | 'focus' | 'calm' }

const hours = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`)

/**
 * The single most useful next move for today, from real data, in priority order. It only ever links somewhere: any
 * change still goes through the planner or Copilot proposals that the user approves.
 */
export function todayGuidance(d: TodayData): Guidance {
  const overdue = d.deadlines.filter(x => x.bucket === 'overdue').length
  if (overdue > 0) return { tone: 'alert', en: `${overdue} item(s) slipped past their deadline. Copilot can propose realistic new dates for you to approve.`, ar: `تجاوز ${overdue} عنصر موعده. يمكن للمساعد اقتراح مواعيد واقعية جديدة لتوافق عليها.`, ctaEn: 'Ask Copilot', ctaAr: 'اسأل المساعد', to: `/assistant?ask=${encodeURIComponent('Reschedule my overdue tasks')}` }
  if (d.period === 'morning' && d.energy.enabled && !d.energy.checkin) return { tone: 'energy', en: 'Check in first, so today’s plan matches your energy.', ar: 'سجّل حالتك أولاً لتناسب خطة اليوم طاقتك.', ctaEn: 'Check in', ctaAr: 'سجّل حالتك', to: '#checkin' }
  if (d.energy.level === 'heavy') return { tone: 'energy', en: `Today is ${d.energy.load_percent}% booked. A lighter plan keeps the must-dos and protects breaks.`, ar: `يومك محجوز بنسبة ${d.energy.load_percent}٪. خطة أخف تحفظ الضروري وتحمي فترات الراحة.`, ctaEn: 'Plan a lighter day', ctaAr: 'خطط ليوم أخف', to: '/today/plan' }
  if (d.period === 'evening') return { tone: 'calm', en: 'Close the day: note one win and choose tomorrow’s first step.', ar: 'اختم يومك: دوّن إنجازاً واحداً واختر خطوة الغد الأولى.', ctaEn: 'Reflect with Copilot', ctaAr: 'تأمل مع المساعد', to: `/assistant?ask=${encodeURIComponent('Help me reflect on my week')}` }
  if (d.focus_time.next_task && d.focus_time.free_minutes >= 30) return { tone: 'focus', en: `${hours(d.focus_time.free_minutes)} free today. Best next move: “${d.focus_time.next_task.title}”.`, ar: `لديك ${hours(d.focus_time.free_minutes)} متاحة اليوم. أفضل خطوة تالية: «${d.focus_time.next_task.title}».`, ctaEn: 'Start focus', ctaAr: 'ابدأ التركيز', to: `/focus?task=${d.focus_time.next_task.id}` }
  return { tone: 'calm', en: 'Your day is clear. Shape it before it shapes you.', ar: 'يومك متاح. شكّله قبل أن يشكّلك.', ctaEn: 'Plan my day', ctaAr: 'خطط يومي', to: '/today/plan' }
}
