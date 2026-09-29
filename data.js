// Prices are DKK/kWh. All dates/hours are Europe/Copenhagen, not device local time.
export const ZONE = 'Europe/Copenhagen';
export const GLN = '5790000395620'; // NOE Net, address lookup verified 2026-09-29.
const API = 'https://elpriser.org/api';
const KEY = 'elprisudsigt-v1:';
const memory = new Map();
const dateFormatter = new Intl.DateTimeFormat('sv-SE', {timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit'});
const hourFormatter = new Intl.DateTimeFormat('en-GB',{timeZone:ZONE,hour:'2-digit',hourCycle:'h23'});
const clock = new Intl.DateTimeFormat('da-DK',{timeZone:ZONE,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export const dateKey = (d=new Date()) => dateFormatter.format(d);
export const formatPrice = n => Number.isFinite(n) ? n.toLocaleString('da-DK',{minimumFractionDigits:2,maximumFractionDigits:2}) : '…';
function read(k) { try { return JSON.parse(localStorage.getItem(KEY+k)) ?? memory.get(k); } catch { return memory.get(k); } }
function store(k,v) { memory.set(k,v); try { localStorage.setItem(KEY+k,JSON.stringify(v)); } catch {} }
export function getSettings() { const s=read('settings'); return {markup:Number.isFinite(s?.markup)&&s.markup>=0&&s.markup<=10?s.markup:0.09}; }
export function saveSettings(s) { const n=Number(String(s.markup).replace(',','.')); if(!Number.isFinite(n)||n<0||n>10)throw Error('Tillæg skal være mellem 0 og 10 kr./kWh.');store('settings',{markup:n}); }
export function addDays(date,n) { return new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10); }
export function slots(date) {
 const out=[],center=Date.parse(date+'T00:00:00Z');
 for(let t=center-4*3600000;t<center+28*3600000;t+=3600000)if(dateKey(new Date(t))===date){
  const d=new Date(t),e=new Date(t+3600000),hour=Number(hourFormatter.format(d));
  out.push({start:d.toISOString(),end:e.toISOString(),hour,label:clock.format(d).replace('.',':')+'-'+clock.format(e).replace('.',':')});
 }
 const counts={};out.forEach(s=>counts[s.hour]=(counts[s.hour]||0)+1);
 out.forEach(s=>{if(counts[s.hour]>1)s.label+=' ('+new Intl.DateTimeFormat('en-GB',{timeZone:ZONE,timeZoneName:'shortOffset'}).formatToParts(new Date(s.start)).find(p=>p.type==='timeZoneName').value+')';});
 return out;
}
function records(v){return Array.isArray(v)?v:(v?.records??[]);}
function validAt(r,date){return r.ValidFrom?.slice(0,10)<=date&&(!r.ValidTo||date<r.ValidTo.slice(0,10));}
export function tariffFor(rows,date,hour){
 const r=records(rows).filter(r=>validAt(r,date)).sort((a,b)=>b.ValidFrom.localeCompare(a.ValidFrom))[0];
 if(!r)return null;
 const n=r['Price'+(hour+1)] ?? (r.ResolutionDuration==='P1D'?r.Price1:null);
 return typeof n==='number'&&Number.isFinite(n)?n:null;
}
export function chargesFor(rows,date){
 const values=['40000','41000','EA-001'].map(code=>records(rows).filter(r=>r.ChargeTypeCode===code&&validAt(r,date)).sort((a,b)=>b.ValidFrom.localeCompare(a.ValidFrom))[0]?.Price1);
 return values.every(v=>typeof v==='number'&&Number.isFinite(v))?values.reduce((a,b)=>a+b,0):null;
}
export function officialHours(raw){
 const groups=new Map();
 for(const r of records(raw)){
  if(r.PriceArea!=='DK1'||!Number.isFinite(r.DayAheadPriceDKK))continue;
  const time=Date.parse(r.TimeUTC.endsWith('Z')?r.TimeUTC:r.TimeUTC+'Z');if(!Number.isFinite(time))continue;
  const hour=Math.floor(time/3600000)*3600000;
  if(!groups.has(hour))groups.set(hour,new Map());groups.get(hour).set(time,r.DayAheadPriceDKK/1000);
 }
 const out=new Map();
 for(const [t,g] of groups){
  // Current EDS feed is quarter-hourly. Require all 4 quarters, never average a partial hour.
  if([0,15,30,45].every(m=>g.has(t+m*60000)))out.set(new Date(t).toISOString(),[...g.values()].reduce((a,b)=>a+b,0)/4);
 }
 return out;
}
export function buildDays(bundle,now=new Date(),markup=0.09){
 const today=dateKey(now),actual=officialHours(bundle.actual),fd=bundle.forecast?.days??[];
 return Array.from({length:7},(_,i)=>{
  const date=addDays(today,i),ss=slots(date),f=fd.find(d=>d.date===date),national=chargesFor(bundle.charges,date);
  const hours=ss.flatMap(s=>{
   let spot=actual.get(s.start),type='official';
   if(spot===undefined){
    const fp=f?.prices?.find(p=>p.hour===s.hour);
    if(!fp||!Number.isFinite(fp.price))return [];
    // A 24-point provider forecast cannot distinguish the two autumn 02:00 hours.
    // Repeated forecast hour is explicitly an estimate, even if provider calls day actual.
    spot=fp.price;type=f.type==='actual'&&ss.length===24?'official':'forecast';
   }
   const grid=tariffFor(bundle.tariff,date,s.hour);
   if(grid===null||national===null)return [];
   return [{...s,spot,grid,national,price:(spot+grid+national)*1.25+markup,type}];
  });
  const values=hours.map(h=>h.price),kinds=new Set(hours.map(h=>h.type));
  return {date,label:i===0?'I dag':new Intl.DateTimeFormat('da-DK',{timeZone:ZONE,weekday:'short'}).format(new Date(date+'T12:00:00Z')).replace('.','').replace(/^./,s=>s.toUpperCase()),longLabel:new Intl.DateTimeFormat('da-DK',{timeZone:ZONE,weekday:'long',day:'numeric',month:'long'}).format(new Date(date+'T12:00:00Z')),type:!hours.length?'missing':kinds.size>1?'mixed':hours[0].type,hours,expectedHours:ss.length,min:values.length?Math.min(...values):null,max:values.length?Math.max(...values):null,average:values.length?values.reduce((a,b)=>a+b,0)/values.length:null};
 });
}
async function endpoint(name,url,force,validate){
 const cached=read(name);
 if(!force&&cached&&Date.now()-cached.at<300000&&validate(cached.value))return {...cached,stale:false};
 try{
  const r=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(18000)});if(!r.ok)throw Error('HTTP '+r.status);
  const value=await r.json();if(!validate(value))throw Error('Ugyldigt datasvar');
  const next={at:Date.now(),value};store(name,next);return {...next,stale:false};
 }catch(e){if(cached&&validate(cached.value))return {...cached,stale:true};throw e;}
}
let pending;
export async function loadPrices({force=false}={}){
 if(pending)return pending;
 pending=(async()=>{
  const today=dateKey(),end=addDays(today,2);
  const specs=[['forecast',`${API}/forecast?area=DK1&mode=spot_ex`,v=>v?.area==='DK1'&&v.mode==='spot_ex'&&Array.isArray(v.days)&&v.days.some(d=>d.prices?.some(p=>Number.isFinite(p.price)))],['actual:'+today,`${API}/raw/prices?area=DK1&start=${today}&end=${end}`,v=>Array.isArray(v?.records)&&v.records.length>0],['tariff',`${API}/raw/tariff?gln=${GLN}`,v=>records(v).some(r=>Number.isFinite(r.Price1))],['charges',`${API}/raw/encharges`,v=>records(v).some(r=>r.ChargeTypeCode==='EA-001')]];
  const result=await Promise.allSettled(specs.map(([n,u,v])=>endpoint(n,u,force,v)));
  const previous=read('bundle');const names=['forecast','actual','tariff','charges'];const bundle={};let stale=false,at=Date.now();
  result.forEach((r,i)=>{if(r.status==='fulfilled'){bundle[names[i]]=r.value.value;stale ||= r.value.stale;at=Math.min(at,r.value.at);}else{stale=true;bundle[names[i]]=previous?.bundle?.[names[i]];if(previous)at=Math.min(at,previous.at);}});
  const days=buildDays(bundle,new Date(),getSettings().markup);
  if(!days.some(d=>d.hours.length))throw Error('Priserne kunne ikke hentes. Prøv igen om lidt.');
  if(!stale)store('bundle',{bundle,at});
  const missing=days.some(d=>d.hours.length!==d.expectedHours);
  const old=at<Date.now()-24*3600000;
  return {days,updated:clock.format(new Date(at)).replace('.',':'),stale,message:[stale?'Senest hentede data'+(old?' fra '+dateKey(new Date(at)):''):'',missing?'Nogle timer mangler hos datakilden. Gennemsnit er for viste timer.':''].filter(Boolean).join(' · '),assumptions:'DK1. NOE Net C-tarif valgt efter adresseopslag, ikke L-NET. Inkl. 25 % moms, tidsafhængig nettarif, Energinets net- og systemtarif samt elafgift. EVDK-tillæg er angivet inkl. moms; standard 0,09 kr./kWh (offentlig normalpris). Din konkrete aftale og eventuelle introduktionsrabat er ikke bekræftet. Faste abonnementer er ikke medregnet. Officielle kvarterspriser vises som timegennemsnit; prognoser er estimater, mere usikre længere frem. Ved skift til vintertid bruges samme estimerede spotpris til begge kl. 02, hvis kilden kun leverer 24 prognoseværdier. Data: elpriser.org / Energinet. Tariffer kontrolleret 29. september 2026.'};
 })();try{return await pending;}finally{pending=null;}
}
