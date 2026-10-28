import NotificationCenter from './NotificationCenter'
import { confirmSignOut } from '../../lib/offline'
import { Suspense, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Menu, Moon, Sun, Languages, Search, Plus, LogOut, Sparkles } from 'lucide-react'
import { useTheme } from '../../contexts/ThemeContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { useAuth } from '../../contexts/AuthContext'
import { useText } from '../../lib/i18n'
import { api, type RecordItem } from '../../lib/api'
import { Dialog, ErrorMessage } from '../ui/Shared'
import { openQuickAdd } from '../../lib/quickAdd'
import { lazyPart } from '../../lib/lazyPart'
// Loaded when a search result is opened, so it stays out of the bundle every page loads.
const RecordForm = lazyPart(() => import('../../features/ResourcePage').then(m => m.RecordForm))
export default function Topbar({onMenuClick}:{onMenuClick:()=>void}){const t=useText(),theme=useTheme(),language=useLanguage(),auth=useAuth(),navigate=useNavigate();const [draft,setDraft]=useState<Partial<RecordItem>|null>(null),[search,setSearch]=useState(false),[query,setQuery]=useState(''),[results,setResults]=useState<RecordItem[]>([]),[error,setError]=useState('');useEffect(()=>{function key(e:KeyboardEvent){if((e.ctrlKey||e.metaKey)&&e.key==='k'){e.preventDefault();setSearch(s=>!s)}}window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)},[]);useEffect(()=>{let cancelled=false;const timer=setTimeout(()=>{if(search)api<{data:RecordItem[]}>(`/api/tasks?search=${encodeURIComponent(query)}`).then(v=>{if(!cancelled)setResults(v.data)}).catch(e=>{if(!cancelled)setError(e.message)})},250);return()=>{cancelled=true;clearTimeout(timer)}},[query,search]);
 async function preferences(data:object){try{await api('/api/settings','PUT',data)}catch(e){setError((e as Error).message)}}
 return <><header className="topbar"><div className="toolbar"><button className="icon-button" onClick={onMenuClick} aria-label={t('Toggle menu','تبديل القائمة')}><Menu size={20}/></button><button className="search-trigger" onClick={()=>setSearch(true)}><Search size={17}/><span>{t('Search your workspace','ابحث في مساحة عملك')}</span><kbd>Ctrl K</kbd></button></div><div className="toolbar"><button className="icon-button" aria-label={t('Quick add','إضافة سريعة')} onClick={openQuickAdd}><Plus size={21}/></button><Link to="/assistant" className="icon-button" aria-label={t('Assistant','المساعد')}><Sparkles size={20}/></Link><button className="icon-button hide-phone" aria-label={language.language==='ar'?'English':'العربية'} onClick={()=>{const next=language.language==='ar'?'en':'ar';language.setLanguage(next);void preferences({language:next})}}><Languages size={20}/></button><button className="icon-button hide-phone" aria-label={t('Change theme','تغيير المظهر')} onClick={()=>{const next=theme.resolvedTheme==='dark'?'light':'dark';theme.setTheme(next);void preferences({theme:next})}}>{theme.resolvedTheme==='dark'?<Sun size={20}/>:<Moon size={20}/>}</button><NotificationCenter/><button className="avatar" title={auth.user?.name} aria-label={`${auth.user?.name ?? ''} · ${t('Settings','الإعدادات')}`} onClick={()=>navigate('/settings')}>{auth.user?.name.slice(0,1)}</button><button className="icon-button hide-phone" aria-label={t('Sign out','تسجيل الخروج')} onClick={()=>{if(confirmSignOut((count: number) => t(`${count} change(s) kept on this device will be deleted. Sign out anyway?`, `سيُحذف ${count} تغيير محفوظ على هذا الجهاز. هل تريد تسجيل الخروج؟`)))auth.logout().catch(e=>setError(e.message))}}><LogOut size={18}/></button></div></header><ErrorMessage error={error}/>
 {draft&&<Suspense fallback={null}><RecordForm resource="tasks" item={draft} onSave={()=>navigate('/tasks')} onClose={()=>setDraft(null)}/></Suspense>}
 {search&&<Dialog title={t('Search & commands','البحث والأوامر')} onClose={()=>setSearch(false)}><input data-autofocus aria-label={t('Search','بحث')} value={query} onChange={e=>setQuery(e.target.value)} placeholder={t('Find a task…','ابحث عن مهمة…')}/><div className="toolbar">{[['/tasks','Tasks','المهام'],['/today/plan','Plan my day','خطط يومي'],['/focus','Start focus','بدء التركيز']].map(([path,en,ar])=><Link className="quiet" key={path} to={path} onClick={()=>setSearch(false)}>{t(en,ar)}</Link>)}</div>{results.map(item=><button className="search-result" key={item.id} onClick={()=>{setSearch(false);setDraft(item)}}>{item.title}</button>)}</Dialog>}
 </>
}


