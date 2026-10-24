
import { ArrowUpRight, Sparkles } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useLanguage } from '../../contexts/LanguageContext'

export default function WelcomeHeader() {
  const { language } = useLanguage()
  const reduceMotion = useReducedMotion()
  const ar = language === 'ar'

  return (
    <motion.section
      initial={reduceMotion ? false : { opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45 }}
      className="relative overflow-hidden rounded-3xl p-7 md:p-10"
      style={{
        background:
          'linear-gradient(120deg, #312e81 0%, #6366f1 65%, #0891b2 100%)',
        color: '#ffffff',
      }}
    >
      <div className="pointer-events-none absolute -end-16 -top-20 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 start-1/2 h-48 w-48 rounded-full bg-cyan-300/15 blur-3xl" />

      <div className="relative z-10 max-w-2xl">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-4 py-2 text-sm">
          <Sparkles size={16} />
          {ar ? 'مساحة عملك الذكية' : 'Your intelligent workspace'}
        </div>

        <h1 className="text-3xl font-bold leading-tight md:text-4xl">
          {ar
            ? 'نظّم يومك، وركّز على الأهم'
            : 'Own your day. Focus on what matters.'}
        </h1>

        <p className="mt-4 max-w-xl text-sm leading-7 text-white/80 md:text-base">
          {ar
            ? 'خطّط وقتك بوضوح، تابع أولوياتك، وحقق تقدمًا مستمرًا نحو أهدافك.'
            : 'Plan with clarity, manage your priorities, and make meaningful progress.'}
        </p>

        <div className="mt-7 flex items-center gap-2 text-sm font-medium text-white/90">
          {ar ? 'ابدأ من أولوياتك اليوم' : "Start with today's priorities"}
          <ArrowUpRight size={18} />
        </div>
      </div>
    </motion.section>
  )
}
