import { BrowserRouter } from 'react-router'
import AppRoutes from './routes/AppRoutes'
import { AuthProvider } from './contexts/AuthContext'
import { ToastProvider } from './components/ui/Toaster'
import PwaManager from './components/layout/PwaManager'
import { ConfirmPasswordProvider } from './components/ui/ConfirmPasswordProvider'
import { Component, type ReactNode } from 'react'
import { LazyMotion, MotionConfig } from 'motion/react'
const motionFeatures=()=>import('./lib/motionFeatures').then(r=>r.default)
class ErrorBoundary extends Component<{children:ReactNode},{error:boolean}>{state={error:false};static getDerivedStateFromError(){return{error:true}}render(){return this.state.error?<main className="empty"><h1>LifeOS</h1><p>Something went wrong. / حدث خطأ.</p><button onClick={()=>location.reload()}>Reload / إعادة تحميل</button></main>:this.props.children}}
export default function App(){return <ErrorBoundary><MotionConfig reducedMotion="user"><LazyMotion features={motionFeatures}><BrowserRouter><ToastProvider><PwaManager/><AuthProvider><ConfirmPasswordProvider><AppRoutes/></ConfirmPasswordProvider></AuthProvider></ToastProvider></BrowserRouter></LazyMotion></MotionConfig></ErrorBoundary>}
