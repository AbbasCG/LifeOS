import type { RecordItem } from './api'
export function parseCapture(text:string, now=new Date()):Partial<RecordItem>{
 const result:Partial<RecordItem>={title:text.trim(),status:'inbox',estimated_minutes:30};const day=new Date(now)
 if(/\btomorrow\b/i.test(text))day.setDate(day.getDate()+1)
 const hour=text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i)
 if(hour){let h=Number(hour[1]);if(hour[3])h=h%12+(hour[3].toLowerCase()==='pm'?12:0);if(h<24&&Number(hour[2]||0)<60){day.setHours(h,Number(hour[2]||0),0,0);result.due_at=day.toISOString()}}
 const duration=text.match(/\bfor\s+(\d+|one|two|an?)\s+(hours?|minutes?)\b/i)
 if(duration){const count=/one|an?/i.test(duration[1])?1:duration[1].toLowerCase()==='two'?2:Number(duration[1]);result.estimated_minutes=Math.max(5,Math.min(10080,count*(duration[2].toLowerCase().startsWith('hour')?60:1)))}
 return result
}
