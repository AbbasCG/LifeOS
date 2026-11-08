import { useLanguage } from '../contexts/LanguageContext'
/**
 * Picks the text for the person's language. Most of the app has English and Arabic only; the optional third text is Dutch,
 * and wherever it is missing Dutch readers get the English text.
 */
export function useText() { const { language } = useLanguage(); return (en: string, ar: string, nl?: string) => language === 'ar' ? ar : language === 'nl' && nl !== undefined ? nl : en }
