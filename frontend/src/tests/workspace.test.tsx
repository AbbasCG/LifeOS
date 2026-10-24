import { describe,it,expect,beforeEach,vi } from 'vitest'
import { render,screen,fireEvent,waitFor,cleanup } from '@testing-library/react'
import { LanguageProvider,useLanguage } from '../contexts/LanguageContext'
import { ThemeProvider,useTheme } from '../contexts/ThemeContext'
import { parseCapture } from '../lib/capture'
import { api } from '../lib/api'
import { Dialog } from '../components/ui/Shared'
function Preferences(){const l=useLanguage(),t=useTheme();return <><button onClick={()=>l.setLanguage(l.language==='ar'?'en':'ar')}>Language</button><button onClick={()=>t.setTheme('dark')}>Dark</button><span>{l.language}</span></>}
beforeEach(()=>{cleanup();localStorage.clear();vi.unstubAllGlobals()})
describe('workspace preferences',()=>{
 it('switches document direction and language',async()=>{render(<ThemeProvider><LanguageProvider><Preferences/></LanguageProvider></ThemeProvider>);expect(document.documentElement.dir).toBe('rtl');fireEvent.click(screen.getByText('Language'));await waitFor(()=>expect(document.documentElement.dir).toBe('ltr'));expect(localStorage.getItem('lifeos-language')).toBe('en')})
 it('applies and saves dark mode',async()=>{render(<ThemeProvider><LanguageProvider><Preferences/></LanguageProvider></ThemeProvider>);fireEvent.click(screen.getByText('Dark'));await waitFor(()=>expect(document.documentElement.dataset.theme).toBe('dark'));expect(localStorage.getItem('lifeos-theme')).toBe('dark')})
})
describe('quick capture',()=>{
 it('creates a reviewable tomorrow evening draft',()=>{const draft=parseCapture('Tomorrow at 7 PM, study Laravel for one hour.',new Date(2026,9,19,12));expect(draft.estimated_minutes).toBe(60);expect(new Date(draft.due_at!).getHours()).toBe(19);expect(new Date(draft.due_at!).getDate()).toBe(20);expect(draft.status).toBe('inbox')})
 it('preserves plain Arabic capture without inventing a date',()=>{const draft=parseCapture('مراجعة الدرس');expect(draft.title).toBe('مراجعة الدرس');expect(draft.due_at).toBeUndefined()})
})
describe('API behavior',()=>{
 it('uses cookie credentials and sends CSRF headers',async()=>{document.cookie='XSRF-TOKEN=test-token';const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({ok:true}),{status:200}));vi.stubGlobal('fetch',fetcher);await api('/api/tasks','POST',{title:'Read'});expect(fetcher).toHaveBeenCalledWith('/api/tasks',expect.objectContaining({credentials:'include',headers:expect.objectContaining({'X-XSRF-TOKEN':'test-token'})}))})
 it('preserves validation errors',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({message:'Invalid title',errors:{title:['Required']}}),{status:422})));await expect(api('/api/tasks','POST',{})).rejects.toMatchObject({status:422,errors:{title:['Required']}})})
})
it('opens an accessible modal and closes via its control',()=>{const close=vi.fn();render(<LanguageProvider><Dialog title="Edit task" onClose={close}><input aria-label="Title"/></Dialog></LanguageProvider>);expect(screen.getByRole('dialog')).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'إغلاق'}));expect(close).toHaveBeenCalledOnce()})
