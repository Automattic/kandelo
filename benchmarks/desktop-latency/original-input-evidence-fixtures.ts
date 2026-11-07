import {qualifyInjectedDelayBounds,nativeVisibleLatencyBounds,clockBounds} from './clock-bounds';
import {preserveInteractionEvidence} from './interaction-evidence-custody';
import {createOriginalInputEvidence, type OriginalInput} from './original-input-evidence';

export function originalInputEvidenceFixtures() {
  const check=(condition: unknown,message: string)=>{if(!condition)throw Error(message);};
  const sample=(eventAt=10,target: string|null='pose-a'):OriginalInput=>({kind:'pointermove',eventAt,handlerAt:100,trusted:true,target,clientX:40,clientY:50,coalesced:[{eventAt:8,clientX:38,clientY:50,trusted:true}]});
  const results:Record<string,unknown>={};
  const ledger=createOriginalInputEvidence({session:'parity'});
  ledger.offer({id:'offered-1',kind:'pointermove',offeredAt:5});
  check(ledger.record(sample()),'Ordinary input refused');
  check(ledger.record(sample(20,null)),'Unplanned input refused');
  const first=ledger.snapshot();check(first.inputs[0].eventAt===10&&first.inputs[0].handlerAt===100,'Handler time replaced original input');
  check(first.inputs[0].coalesced[0].eventAt===8,'Coalesced original time lost');
  check(first.unmatchedInputs===1&&first.offers.length===1,'Unmatched/offered evidence lost');
  first.inputs[0].coalesced[0].eventAt=999;check(ledger.snapshot().inputs[0].coalesced[0].eventAt===8,'Snapshot alias mutated history');
  ledger.beginEpoch();ledger.record(sample(30));const epochs=ledger.snapshot();check(epochs.inputs.length===3&&epochs.currentInputs.length===1&&epochs.currentInputs[0].seq===1&&epochs.currentInputs[0].evidenceSeq===3,'Epoch reset erased or relabelled original history');
  results.originalAndEpochs=epochs;
  const bounded=createOriginalInputEvidence({session:'bounded',maxInputs:1});bounded.record(sample());
  check(!bounded.record(sample(20)),'Input overflow accepted');bounded.beginEpoch();check(!bounded.record(sample(30)),'Reset recovered from lost tail');
  const overflow=bounded.snapshot();check(!overflow.complete&&overflow.refusedInputs===2&&(overflow.failure!.item as any).eventAt===20&&(overflow.lastRefusedInput as any).eventAt===30,'Refused tail provenance lost');results.overflow=overflow;
  const coalesced=createOriginalInputEvidence({session:'coalesced',maxCoalesced:1});
  check(!coalesced.recordEvent({type:'pointermove',timeStamp:50,isTrusted:true,getCoalescedEvents:()=>[{timeStamp:40,isTrusted:true},{timeStamp:45,isTrusted:true},{timeStamp:48,isTrusted:true}]},90),'Coalesced overflow accepted');
  const c=coalesced.snapshot();check((c.failure!.item as any).coalescedCount===3&&(c.failure!.item as any).coalesced.length===1,'Exact refused coalesced count lost');results.coalescedOverflow=c;
  const duplicate=createOriginalInputEvidence({session:'offers'});duplicate.offer({id:'same',kind:'keydown',offeredAt:1});check(!duplicate.offer({id:'same',kind:'keydown',offeredAt:2}),'Reused offered identity accepted');results.duplicateOffer=duplicate.snapshot();
  const invalid=createOriginalInputEvidence({session:'invalid'});check(!invalid.record(sample(Number.NaN)),'Invalid original timestamp accepted');results.invalidTime=invalid.snapshot();
  const thrown=createOriginalInputEvidence({session:'thrown'});check(!thrown.recordEvent({type:'pointermove',timeStamp:12,isTrusted:true,getCoalescedEvents:()=>{throw Error('owned-read-refusal');}},35),'Read failure hidden');check((thrown.snapshot().failure!.item as any).eventAt===12,'Read failure original endpoint lost');results.readFailure=thrown.snapshot();
  const scalar=createOriginalInputEvidence({session:'scalar'});scalar.offer({id:'scalar-offer',kind:'pointermove',offeredAt:1,unrelated:new Uint8Array(1024)} as any);check(!('unrelated' in scalar.snapshot().offers[0]),'Unknown offer authority retained');const extra={...sample(),unrelated:new Uint8Array(1024)};scalar.record(extra);check(!('unrelated' in scalar.snapshot().inputs[0]),'Unknown caller authority retained');results.scalarOnly=scalar.snapshot();
  const keys=createOriginalInputEvidence({session:'key-wheel'});keys.recordEvent({type:'keydown',timeStamp:5,isTrusted:false,key:'A',code:'KeyA',repeat:false},8);keys.recordEvent({type:'wheel',timeStamp:9,isTrusted:false,deltaX:2,deltaY:120},10);results.keysAndWheel=keys.snapshot();
  for(const value of [0,-1,65537,1.5]){let rejected=false;try{createOriginalInputEvidence({session:'invalid-budget',maxInputs:value});}catch{rejected=true;}check(rejected,'Invalid capacity accepted');}
  return results;
}


export async function originalInputFailureFixtures() {
 const check=(condition:unknown,message:string)=>{if(!condition)throw Error(message);};
 const result:Record<string,unknown>={};
 for(const name of ['helper-threw','response-deadline']) {
  const ledger=createOriginalInputEvidence({session:name});ledger.offer({id:'offered-before-rejection',kind:'pointermove',offeredAt:1});ledger.record({kind:'pointermove',eventAt:2,handlerAt:3,trusted:true,target:null,coalesced:[]});
  const original=Error(name);let caught:unknown,record:any;
  try{await preserveInteractionEvidence(()=>Promise.reject(original),()=>ledger.snapshot(),async()=>ledger.snapshot(),row=>{record=row;},20);}catch(error){caught=error;}
  check(caught===original,'Original rejection identity changed');check(record.localEvidence.offers.length===1&&record.sourceEvidence.unmatchedInputs===1,'Rejected operation lost offered/unmatched input');result[name]=record;
 }
 const original=Error('original-operation'),source=Error('source-unavailable'),persistence=Error('persistence-refused');let sourceRecord:any,combined:unknown;
 try{await preserveInteractionEvidence(()=>Promise.reject(original),()=>({offers:['retained-local-offer']}),()=>Promise.reject(source),record=>{sourceRecord=record;},20);}catch(error){combined=error;}
 check(combined instanceof AggregateError&&combined.errors[0]===original&&combined.errors[1]===source,'Unavailable source hid a failure');check(sourceRecord.evidenceAvailable===false&&sourceRecord.localEvidence.offers.length===1,'Unavailable source lost local offers or claimed success');result.sourceUnavailable=sourceRecord;
 let persistedRecord:any;combined=undefined;
 try{await preserveInteractionEvidence(()=>Promise.reject(original),()=>({offers:['retained-local-offer']}),async()=>({inputs:['unmatched-original']}),record=>{persistedRecord=record;throw persistence;},20);}catch(error){combined=error;}
 check(combined instanceof AggregateError&&combined.errors[0]===original&&combined.errors[1]===persistence,'Persistence failure swallowed original failure');result.persistenceFailure={record:persistedRecord,errors:(combined as AggregateError).errors.map(String)};
 const pendingLedger=createOriginalInputEvidence({session:'never-source'});pendingLedger.offer({id:'still-owned',kind:'cursor-stimulus',offeredAt:1});
 const phases:any[]=[];let localWasDurable=false;combined=undefined;
 try{await preserveInteractionEvidence(()=>Promise.reject(original),()=>pendingLedger.snapshot(),()=>{localWasDurable=phases.length===1&&phases[0].phase==='local-captured';return new Promise(()=>{});},record=>{phases.push(record);},20);}catch(error){combined=error;}
 check(localWasDurable,'Source entered before local offers were persisted');check(combined instanceof AggregateError&&combined.errors[0]===original,'Timeout lost original operation failure');check(phases.length===2&&phases[1].sourceStatus==='timeout'&&phases[1].localEvidence.offers.length===1,'Timeout lost local offers or hid unavailable source');result.neverResolvingSource={phases,errors:(combined as AggregateError).errors.map(String)};
 let touched=false;try{await preserveInteractionEvidence(async()=>{touched=true;},()=>({}),async()=>({}),()=>{},0);}catch{}check(!touched,'Invalid budget started operation');
 const pc=clockBounds([{n0:0,n1:0,b:0}],2),nc=clockBounds([{n0:0,n1:0,b:0}],.25);
 const wide=nativeVisibleLatencyBounds(100,0,1000,{lo:pc.lo-nc.hi,hi:pc.hi-nc.lo});
 check(wide.hi>=49,'Wide negative control misses former upper-only acceptance');
 const uncertain=qualifyInjectedDelayBounds(wide,50,2.25);check(uncertain.status==='uncertain','Wide capture gap falsely proved injected delay');
 const good=qualifyInjectedDelayBounds({lo:48,hi:52},50,2.25);check(good.status==='qualified','Informative lower bound refused');
 check(qualifyInjectedDelayBounds({lo:46,hi:1000},50,2.25).status==='uncertain','Capture gap enlarged clock tolerance');
 let invalid=false;try{qualifyInjectedDelayBounds({lo:0,hi:1000},50,1000);}catch{invalid=true;}check(invalid,'Unbounded clock tolerance accepted');
 let deliver!:(value:unknown)=>void;const lateSource=new Promise(resolve=>{deliver=resolve;}),lateRecords:any[]=[];let lateCaught:unknown;
 try{await preserveInteractionEvidence(()=>Promise.reject(original),()=>({offers:['retained-before-late']}),()=>lateSource,row=>{lateRecords.push(row);},20);}catch(error){lateCaught=error;}
 check(lateCaught instanceof AggregateError&&lateRecords[1].sourceStatus==='timeout','Late source control did not reach timeout');
 const sourceSettled=lateSource.then(()=>undefined);deliver({inputs:['late-input']});await sourceSettled;
 check(lateRecords.length===2&&lateRecords[1].sourceStatus==='timeout','Late source rewrote terminal evidence');result.lateSource={records:lateRecords,errors:(lateCaught as AggregateError).errors.map(String)};
 result.delayQualification={wide,uncertain,good};
 return result;
}
