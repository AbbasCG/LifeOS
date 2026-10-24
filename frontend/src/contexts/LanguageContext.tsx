
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'

type Language = 'ar' | 'en'

const translations = {
  ar: {
    title: 'لايف أو إس',
    subtitle: 'مساحة عملك الذكية لتنظيم الوقت والمهام',
    language: 'اللغة',
    appearance: 'المظهر',
    light: 'فاتح',
    dark: 'داكن',
    system: 'النظام',
    ready: 'نظام التصميم جاهز',
  },
  en: {
    title: 'LifeOS',
    subtitle: 'Your intelligent productivity workspace',
    language: 'Language',
    appearance: 'Appearance',
    light: 'Light',
    dark: 'Dark',
    system: 'System',
    ready: 'Design system ready',
  },
} as const

type TranslationKey = keyof typeof translations.en

type LanguageContextValue = {
  language: Language
  setLanguage: (language: Language) => void
  t: (key: TranslationKey) => string
}

const LanguageContext = createContext<LanguageContextValue | undefined>(
  undefined
)

function getSavedLanguage(): Language {
  try {
    const saved = localStorage.getItem('lifeos-language')
    return saved === 'ar' || saved === 'en' ? saved : 'ar'
  } catch {
    return 'ar'
  }
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(getSavedLanguage)

  useEffect(() => {
    document.documentElement.lang = language
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr'

    try {
      localStorage.setItem('lifeos-language', language)
    } catch {
      // Continue without persistent storage.
    }
  }, [language])

  const t = (key: TranslationKey) => translations[language][key]

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage() {
  const context = useContext(LanguageContext)

  if (!context) {
    throw new Error('useLanguage must be used inside LanguageProvider')
  }

  return context
}
