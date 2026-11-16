/** The small, always-loaded rules of the prayer settings (the city list itself is a separate lazy file). */
export type Method = 'umm_al_qura' | 'muslim_world_league' | 'egyptian' | 'karachi' | 'north_america' | 'kuwait' | 'qatar' | 'turkey'
const BY_COUNTRY: Record<string, Method> = { SA: 'umm_al_qura', EG: 'egyptian', KW: 'kuwait', QA: 'qatar', TR: 'turkey', PK: 'karachi', BD: 'karachi', US: 'north_america', CA: 'north_america' }
/** The calculation method usually used in a country (ISO code); the Muslim World League elsewhere. Only a suggestion: the user can change it. */
export const methodForCountry = (country: string): Method => BY_COUNTRY[country] ?? 'muslim_world_league'

/** A typed coordinate: '' is "none yet" (no error); anything that is not a number inside ±limit is an error. Accepts a comma and Arabic digits. */
export function parseCoord(text: string, limit: number): { value: number | null; error: boolean } {
  const clean = text.trim().replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[,٫]/g, '.')
  if (clean === '') return { value: null, error: false }
  const value = /^-?\d+(\.\d+)?$/.test(clean) ? Number(clean) : NaN
  return Number.isFinite(value) && Math.abs(value) <= limit ? { value, error: false } : { value: null, error: true }
}
