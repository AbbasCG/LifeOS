import { Suspense, lazy, type ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import { useAuth } from '../contexts/AuthContext'
import AppLayout from '../components/layout/AppLayout'
import AuthPage from '../features/AuthPage'
const Dashboard=lazy(()=>import('../features/Dashboard'))
const ResourcePage=lazy(()=>import('../features/ResourcePage'))
const CalendarPage=lazy(()=>import('../features/CalendarPage'))
const PlanningPage=lazy(()=>import('../features/PlanningPage'))
const FocusPage=lazy(()=>import('../features/FocusPage'))
const SettingsPage=lazy(()=>import('../features/SettingsPage'))
const AnalyticsPage=lazy(()=>import('../features/AnalyticsPage'))
const ProjectDetail=lazy(()=>import('../features/ProjectDetail'))
const AssistantPage=lazy(()=>import('../features/AssistantPage'))
function Protected({children}:{children:ReactNode}){const {user,loading}=useAuth();if(loading)return <div className="empty" role="status">LifeOS…</div>;return user?children:<Navigate to="/login" replace/>}
export default function AppRoutes(){return <Suspense fallback={<div className="empty" role="status">LifeOS…</div>}><Routes><Route path="/login" element={<AuthPage/>}/><Route path="/register" element={<AuthPage mode="register"/>}/><Route path="/forgot-password" element={<AuthPage mode="forgot"/>}/><Route path="/reset-password" element={<AuthPage mode="reset"/>}/><Route element={<Protected><AppLayout/></Protected>}><Route index element={<Dashboard/>}/><Route path="tasks" element={<ResourcePage key="tasks" resource="tasks"/>}/><Route path="projects" element={<ResourcePage key="projects" resource="projects"/>}/><Route path="projects/:id" element={<ProjectDetail/>}/><Route path="goals" element={<ResourcePage key="goals" resource="goals"/>}/><Route path="habits" element={<ResourcePage key="habits" resource="habits"/>}/><Route path="categories" element={<ResourcePage key="categories" resource="categories"/>}/><Route path="calendar" element={<CalendarPage/>}/><Route path="planning" element={<PlanningPage/>}/><Route path="focus" element={<FocusPage/>}/><Route path="settings" element={<SettingsPage/>}/><Route path="analytics" element={<AnalyticsPage/>}/><Route path="assistant" element={<AssistantPage/>}/></Route><Route path="*" element={<Navigate to="/" replace/>}/></Routes></Suspense>}
