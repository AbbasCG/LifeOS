import { useEffect,useState } from 'react'
import { Outlet } from 'react-router'
import Sidebar from './Sidebar'
import Topbar from './Topbar'
import { api } from '../../lib/api'
import { useLanguage } from '../../contexts/LanguageContext'
import { useTheme } from '../../contexts/ThemeContext'
export default function AppLayout(){const [sidebarOpen,setSidebarOpen]=useState(false);const {setLanguage}=useLanguage(),{setTheme}=useTheme();useEffect(()=>{api<{language?:'ar'|'en';theme?:'light'|'dark'|'system'}>('/api/settings').then(p=>{if(p.language)setLanguage(p.language);if(p.theme)setTheme(p.theme)}).catch(()=>{})},[setLanguage,setTheme]);return <div className={`app-shell ${sidebarOpen?'menu-open':''}`}><Sidebar open={sidebarOpen} onClose={()=>setSidebarOpen(false)}/><div className="app-content"><Topbar onMenuClick={()=>setSidebarOpen(v=>!v)}/><main><Outlet/></main></div></div>}
