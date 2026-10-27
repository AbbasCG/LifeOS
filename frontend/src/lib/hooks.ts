import { useEffect, useState, useCallback, useRef } from 'react'
import { api, ApiError, type RecordItem } from './api'
type Result={key:string;items:RecordItem[];lastPage:number;error:string}
export function useRecords(resource:string,query=''){
 const [page,setPage]=useState(1),[revision,setRevision]=useState(0),[result,setResult]=useState<Result>({key:'',items:[],lastPage:1,error:''});const key=`/api/${resource}?page=${page}&${query}`;const requestKey=`${key}#${revision}`;const current=useRef(requestKey)
 useEffect(()=>{current.current=requestKey;let active=true;api<{data:RecordItem[];meta?:{last_page:number}}>(key).then(value=>{if(active&&current.current===requestKey)setResult({key:requestKey,items:value.data,lastPage:value.meta?.last_page||1,error:''})}).catch(e=>{if(active)setResult(r=>({key:requestKey,items:e instanceof ApiError&&e.status===0?r.items:[],lastPage:e instanceof ApiError&&e.status===0?r.lastPage:1,error:e.message}))});return()=>{active=false}},[key,requestKey])
 const reload=useCallback(async()=>{setRevision(v=>v+1)},[])
 const setError=useCallback((error:string)=>setResult(r=>({...r,error})),[])
 const setItems=useCallback((items:RecordItem[])=>setResult(r=>({...r,items})),[])
 return{items:result.items,setItems,error:result.error,setError,loading:result.key!==requestKey,reload,page,setPage,lastPage:result.lastPage}
}
export function localDate(date=new Date()){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`}
export function localInput(value?:string|null){if(!value)return '';const date=new Date(value);return `${localDate(date)}T${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`}
