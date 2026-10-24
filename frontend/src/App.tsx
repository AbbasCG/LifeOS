import { BrowserRouter } from 'react-router'
import AppRoutes from './routes/AppRoutes'
import { AuthProvider } from './contexts/AuthContext'
import { Component, type ReactNode } from 'react'
class ErrorBoundary extends Component<{children:ReactNode},{error:boolean}>{state={error:false};static getDerivedStateFromError(){return{error:true}}render(){return this.state.error?<main className="empty"><h1>LifeOS</h1><p>Something went wrong. / حدث خطأ.</p><button onClick={()=>location.reload()}>Reload / إعادة تحميل</button></main>:this.props.children}}
export default function App(){return <ErrorBoundary><BrowserRouter><AuthProvider><AppRoutes/></AuthProvider></BrowserRouter></ErrorBoundary>}
