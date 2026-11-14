/** Private prototype of an immutable, explicitly serializable time authority.
 * Original custom providers do not acquire this capability by shape or name.
 * Integration must install this same provider on the ordinary kernel path. */
import {canonicalClockId,type ClockReading,type ClockSampler} from './fast-clock-control';
type Descriptor = Readonly<{version:1;kind:'node-hrtime';epochOffsetNs:bigint;startNs:bigint}>
  | Readonly<{version:1;kind:'browser-performance';timeOrigin:number}>;
const descriptors=new WeakMap<object,Descriptor>();
const freeze=Object.freeze;
const perfNow=performance.now.bind(performance),perfOrigin=performance.timeOrigin;
const nodeNow=typeof process!=='undefined'&&typeof process.hrtime?.bigint==='function'
  ?process.hrtime.bigint.bind(process.hrtime):undefined;
const wallNow=Date.now;
function nodeReading(d:Extract<Descriptor,{kind:'node-hrtime'}>,id:number):ClockReading{
 const now=nodeNow!();const ns=id===2||id===3?now-d.startNs:id===1||id===7?now:now+d.epochOffsetNs;
 return{sec:ns/1_000_000_000n,nsec:ns%1_000_000_000n};
}
function browserReading(d:Extract<Descriptor,{kind:'browser-performance'}>,id:number):ClockReading{
 const now=perfNow();
 const ms=id===1||id===2||id===3||id===7?(perfOrigin-d.timeOrigin)+now:perfOrigin+now;
 const sec=Math.floor(ms/1000);
 const nsec=Math.min(999_999_999,Math.max(0,Math.floor((ms-sec*1000)*1_000_000)));
 return{sec:BigInt(sec),nsec:BigInt(nsec)};
}
export function decodeFastClockDescriptor(value:unknown):ClockSampler|undefined{
 if(!value||typeof value!=='object')return;
 const d=value as Descriptor;if(d.version!==1)return;
 if(d.kind==='node-hrtime'&&nodeNow&&typeof d.epochOffsetNs==='bigint'&&typeof d.startNs==='bigint'){
  const copy=freeze({...d});return id=>nodeReading(copy,id);
 }
 if(d.kind==='browser-performance'&&Number.isFinite(d.timeOrigin)&&d.timeOrigin>0){
  const copy=freeze({...d});return id=>browserReading(copy,id);
 }
}
export function createImmutableClockProvider(kind:'node'|'browser'):{clockGettime:(id:number)=>{sec:number;nsec:number}}{
 let d:Descriptor;
 if(kind==='node'){
  if(!nodeNow)throw new Error('Node clock authority unavailable');
  const now=nodeNow();d=freeze({version:1,kind:'node-hrtime',epochOffsetNs:BigInt(wallNow())*1_000_000n-now,startNs:now});
 }else d=freeze({version:1,kind:'browser-performance',timeOrigin:perfOrigin});
 const sample=decodeFastClockDescriptor(d)!;
 const provider=freeze({clockGettime(id:number){
  const canonical=canonicalClockId(id);if(canonical===undefined)throw new Error('kernel must validate clock ID');
  const value=sample(canonical);return{sec:Number(value.sec),nsec:Number(value.nsec)};
 }});
 descriptors.set(provider,d);return provider;
}
export function describeFastClockProvider(provider:object,logicalClocks:boolean):Descriptor|undefined{
 return logicalClocks?undefined:descriptors.get(provider);
}
