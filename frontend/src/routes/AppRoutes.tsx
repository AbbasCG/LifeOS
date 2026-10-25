import { Suspense, lazy, type ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import { useAuth } from '../contexts/AuthContext'
import AppLayout from '../components/layout/AppLayout'
import AuthPage from '../features/AuthPage'
import OfflineScreen from '../components/layout/OfflineScreen'
const Dashboard=lazy(()=>import('../features/Dashboard'))
const ResourcePage=lazy(()=>import('../features/ResourcePage'))
const CalendarPage=lazy(()=>import('../features/CalendarPage'))
const PlanningPage=lazy(()=>import('../features/PlanningPage'))
const DayPlanPage=lazy(()=>import('../features/today/DayPlanPage'))
const FocusPage=lazy(()=>import('../features/FocusPage'))
const SettingsPage=lazy(()=>import('../features/SettingsPage'))
const AnalyticsPage=lazy(()=>import('../features/AnalyticsPage'))
const ProjectDetail=lazy(()=>import('../features/ProjectDetail'))
const AssistantPage=lazy(()=>import('../features/AssistantPage'))
const ReviewPage=lazy(()=>import('../features/ReviewPage'))
const SettingsLayout=lazy(()=>import('../features/settings/SettingsLayout'))
const SecuritySettings=lazy(()=>import('../features/settings/SecuritySettings'))
const TimelinePage=lazy(()=>import('../features/timeline/TimelinePage'))
const IntegrationsSettings=lazy(()=>import('../features/settings/IntegrationsSettings'))
const AssistantSettings=lazy(()=>import('../features/settings/AssistantSettings'))
const AiControlCenter=lazy(()=>import('../features/settings/AiControlCenter'))
const NotificationSettings=lazy(()=>import('../features/settings/NotificationSettings'))
const AutomationSettings=lazy(()=>import('../features/settings/AutomationSettings'))
const WellbeingSettings=lazy(()=>import('../features/settings/WellbeingSettings'))
function Protected({children}:{children:ReactNode}){const {user,loading,unreachable,refresh}=useAuth();if(loading)return <div className="empty" role="status">LifeOS…</div>;if(!user&&unreachable)return <OfflineScreen onRetry={()=>void refresh()}/>;return user?children:<Navigate to="/login" replace/>}
export default function AppRoutes(){return <Suspense fallback={<div className="empty" role="status">LifeOS…</div>}><Routes><Route path="/login" element={<AuthPage/>}/><Route path="/register" element={<AuthPage mode="register"/>}/><Route path="/forgot-password" element={<AuthPage mode="forgot"/>}/><Route path="/reset-password" element={<AuthPage mode="reset"/>}/><Route element={<Protected><AppLayout/></Protected>}><Route index element={<Dashboard/>}/><Route path="tasks" element={<ResourcePage key="tasks" resource="tasks"/>}/><Route path="projects" element={<ResourcePage key="projects" resource="projects"/>}/><Route path="projects/:id" element={<ProjectDetail/>}/><Route path="goals" element={<ResourcePage key="goals" resource="goals"/>}/><Route path="habits" element={<ResourcePage key="habits" resource="habits"/>}/><Route path="categories" element={<ResourcePage key="categories" resource="categories"/>}/><Route path="calendar" element={<CalendarPage/>}/><Route path="planning" element={<PlanningPage/>}/><Route path="today/plan" element={<DayPlanPage/>}/><Route path="timeline" element={<TimelinePage/>}/><Route path="review" element={<ReviewPage/>}/><Route path="focus" element={<FocusPage/>}/><Route path="settings" element={<SettingsLayout/>}><Route index element={<SettingsPage/>}/><Route path="security" element={<SecuritySettings/>}/><Route path="integrations" element={<IntegrationsSettings/>}/><Route path="ai" element={<AiControlCenter/>}/><Route path="assistant" element={<AssistantSettings/>}/><Route path="notifications" element={<NotificationSettings/>}/><Route path="automations" element={<AutomationSettings/>}/><Route path="wellbeing" element={<WellbeingSettings/>}/></Route><Route path="analytics" element={<AnalyticsPage/>}/><Route path="assistant" element={<AssistantPage/>}/></Route><Route path="*" element={<Navigate to="/" replace/>}/></Routes></Suspense>}
