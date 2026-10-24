import { useLanguage } from '../contexts/LanguageContext'
export function useText() { const { language } = useLanguage(); return (en: string, ar: string) => language === 'ar' ? ar : en }
