import { useId, useMemo, useState, type ReactNode } from 'react'
import { Check, ChevronRight, Search, X } from 'lucide-react'
import { useText } from '../../lib/i18n'
import { BottomSheet } from '../visual'

export type ChoiceOption<V extends string = string> = { value: V; label: string; icon?: ReactNode; tone?: string; hint?: string }

/**
 * A small set of options as one-tap buttons (a radio group), instead of a drop-down. `tiles` stacks the icon over a short label
 * (the phone's big targets), `chips` lays icon and label side by side and wraps. With `name` a hidden input carries the value, so a plain
 * form post sees exactly what a <select> sent. Every button is at least 44px tall.
 */
export function ChoiceGroup<V extends string>({ label, value, onChange, options, variant = 'chips', name, columns, hideLabel = true }: {
  label: string; value: V; onChange: (value: V) => void; options: ChoiceOption<V>[]; variant?: 'chips' | 'tiles'; name?: string; columns?: number; hideLabel?: boolean
}) {
  return <div className={`choice-group choice-${variant}`} role="radiogroup" aria-label={label} style={columns ? { ['--cols' as string]: columns } : undefined} data-hide-label={hideLabel || undefined}>
    {options.map(o => <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={`choice ${o.tone ? `tone-${o.tone}` : ''}`} onClick={() => onChange(o.value)} title={o.hint}>
      {o.icon && <span className="choice-icon" aria-hidden="true">{o.icon}</span>}<span className="choice-label">{o.label}</span>
    </button>)}
    {name && <input type="hidden" name={name} value={value} />}
  </div>
}

export type PickOption = { id: number | string; title: string; hint?: string; color?: string | null }

/**
 * A compact "pick one" field for long lists (projects, goals, categories, tasks): shows the current choice on one line; tapping it opens a
 * sheet with a search box (once the list is longer than a handful) and big rows. "None" clears it. A hidden input carries the id.
 */
export function PickerField({ label, name, value, onChange, options, icon, loading }: {
  label: string; name?: string; value: string; onChange: (value: string) => void; options: PickOption[]; icon?: ReactNode; loading?: boolean
}) {
  const t = useText(), [open, setOpen] = useState(false), [query, setQuery] = useState(''), listId = useId()
  const current = options.find(o => String(o.id) === value)
  const shown = useMemo(() => { const q = query.trim().toLowerCase(); return q ? options.filter(o => o.title.toLowerCase().includes(q)) : options }, [options, query])
  const close = () => { setOpen(false); setQuery('') }
  return <div className="picker-field">
    <button type="button" className="picker-trigger" aria-haspopup="dialog" aria-expanded={open} aria-label={`${label}: ${current?.title ?? t('None', 'بلا')}`} onClick={() => setOpen(true)}>
      {icon && <span className="picker-icon" aria-hidden="true">{icon}</span>}
      <span className="picker-text"><small>{label}</small><strong dir="auto">{current?.title ?? (loading ? '…' : t('None', 'بلا'))}</strong></span>
      <ChevronRight size={16} className="picker-chev" aria-hidden="true" />
    </button>
    {name && <input type="hidden" name={name} value={value} />}
    {open && <BottomSheet title={label} onClose={close}>
      {options.length > 6 && <label className="picker-search"><Search size={16} aria-hidden="true" /><input data-autofocus type="search" value={query} onChange={e => setQuery(e.target.value)} aria-label={t('Search', 'بحث')} aria-controls={listId} placeholder={t('Search…', 'بحث…')} enterKeyHint="search" autoComplete="off" onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }} />{query && <button type="button" className="icon-button" aria-label={t('Clear', 'مسح')} onClick={() => setQuery('')}><X size={16} /></button>}</label>}
      <ul id={listId} className="picker-list" role="radiogroup" aria-label={label}>
        <li><button type="button" role="radio" aria-checked={!value} className="picker-row" onClick={() => { onChange(''); close() }}><span>{t('None', 'بلا')}</span>{!value && <Check size={16} aria-hidden="true" />}</button></li>
        {shown.map(o => <li key={o.id}><button type="button" role="radio" aria-checked={String(o.id) === value} className="picker-row" onClick={() => { onChange(String(o.id)); close() }}>
          {o.color && <i className="swatch" style={{ background: o.color }} aria-hidden="true" />}<span dir="auto">{o.title}</span>{String(o.id) === value && <Check size={16} aria-hidden="true" />}</button></li>)}
        {shown.length === 0 && <li className="muted picker-empty">{t('Nothing matches.', 'لا نتائج.')}</li>}
      </ul>
    </BottomSheet>}
  </div>
}
