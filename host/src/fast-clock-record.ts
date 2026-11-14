/** Private TS05 record. Only the kernel worker publishes; process workers read.
 * Neither independent SAB contains any guest address-space backing. */
import{clockEpochValue,shareClockEpoch,type ClockEpochAuthority,type ClockBinding,type ClockCertificate,captureValidatedClockCertificate}from'./fast-clock-control';
const load=Atomics.load,store=Atomics.store;
const MAGIC=0x4b435231,WORDS=16;
export type DirectClockInit={version:1;epoch:SharedArrayBuffer;record:SharedArrayBuffer;binding:ClockBinding;provider:unknown};
export function newClockRecord(owner:ClockEpochAuthority,binding:ClockBinding,provider:unknown):DirectClockInit{
 const record=new SharedArrayBuffer(WORDS*4),w=new Int32Array(record);
 store(w,2,binding.pid);store(w,3,binding.tid);store(w,4,binding.generation);store(w,8,MAGIC);
 return Object.freeze({version:1,epoch:shareClockEpoch(owner),record,binding:Object.freeze({...binding}),provider});
}
export function retireClockRecord(init:DirectClockInit):void{const w=new Int32Array(init.record);store(w,1,1);store(w,0,0);}
export function publishClockRecord(owner:ClockEpochAuthority,checkedEpoch:number,init:DirectClockInit,pointer:number,id:number,format:0|1):void{
 const w=new Int32Array(init.record);store(w,0,0);
 if(load(w,1))return;
 const cert=captureValidatedClockCertificate(owner,checkedEpoch,init.binding,pointer,id,format);if(!cert)return;
 store(w,5,pointer);store(w,6,id);store(w,7,format);
 // Last, so a reader can never acquire a partially replaced record.
 if(clockEpochValue(owner)===checkedEpoch)store(w,0,checkedEpoch);
}
export function clockCertificateReader(init:DirectClockInit):()=>ClockCertificate|undefined{
 const w=new Int32Array(init.record);
 if(init.version!==1||w.length!==WORDS||load(w,8)!==MAGIC)throw Error('unsupported clock record');
 return()=>{
  const epoch=load(w,0);if(epoch<=0||load(w,1))return;
  const cert:ClockCertificate={version:1,epoch,pid:load(w,2),tid:load(w,3),generation:load(w,4),pointer:load(w,5)>>>0,clockId:load(w,6),format:load(w,7)as 0|1};
  if(load(w,0)!==epoch||load(w,1))return;return cert;
 };
}
