import { useEffect, useState } from 'react'
import { useParams } from 'react-router'
import { api, type RecordItem } from '../lib/api'
import { useRecords } from '../lib/hooks'
import { useText } from '../lib/i18n'
import { RecordForm } from './ResourcePage'
import { ErrorMessage } from '../components/ui/Shared'
export default function ProjectDetail(){const {id}=useParams(),t=useText(),tasks=useRecords('tasks',`project_id=${id}&per_page=100`);const [project,setProject]=useState<RecordItem|null>(null),[editing,setEditing]=useState(false),[error,setError]=useState('');useEffect(()=>{api<{data:RecordItem}>(`/api/projects/${id}`).then(v=>setProject(v.data)).catch(e=>setError(e.message))},[id]);return <section className="page"><h1>{project?.title}</h1><p className="muted">{project?.description}</p><ErrorMessage error={error||tasks.error}/><section className="panel"><h2>{t('Project tasks','مهام المشروع')}</h2><progress max={Math.max(1,tasks.items.length)} value={tasks.items.filter(t=>t.status==='completed').length}/><p>{tasks.items.filter(t=>t.status==='completed').length}/{tasks.items.length}</p>{tasks.items.map(task=><div className="record-row" key={task.id}>{task.title}</div>)}<button className="primary" onClick={()=>setEditing(true)}>{t('Add task','إضافة مهمة')}</button></section>{editing&&<RecordForm resource="tasks" item={{project_id:Number(id)}} onSave={()=>void tasks.reload()} onClose={()=>setEditing(false)}/>}</section>}
