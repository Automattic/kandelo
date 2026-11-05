import {rendererLost} from "./renderer-loss.js";
import type {GlBinding,GlContextExecutionLease} from "./registry.js";
import {GlProgramJournal,lookupProgramJournal,programJournalSequence} from "./program-journal.js";
import {recordGlError} from "./errors.js";
import {nativeGlFault,rethrowNativeGlFault} from "./native-recovery.js";

export const PROGRAM_JOURNAL_REPLY_BYTES=48;
export const PROGRAM_JOURNAL_MAX_ENTRIES=256;
const MAGIC=0x47514c33;
export function journalInteger(view:DataView,offset:number):number {
  return view.getUint32(offset,true)+view.getUint32(offset+4,true)*0x1_0000_0000;
}
function safeCounter(view:DataView,offset:number):boolean {
  return view.getUint32(offset+4,true)<=0x1f_ffff && journalInteger(view,offset)!==0;
}
/** Validate the complete nested shape before native effects or receipt custody. */
export function validProgramJournalRequest(input:Uint8Array,outputBytes:number):boolean {
  if(outputBytes!==48 || input.byteLength<4 || input.byteLength%4 || input.byteLength>8204)return false;
  const v=new DataView(input.buffer,input.byteOffset,input.byteLength),action=v.getUint32(0,true),n=input.byteLength;
  if(action===6)return n===4;
  if(action===7)return n===8 && v.getUint32(4,true)!==0;
  if(n<8 || !v.getUint32(4,true))return false;
  if(action===8 || action===9)return n===16;
  if(action===10)return n===16 && v.getUint32(8,true)!==0 && v.getUint32(12,true)>0 && v.getUint32(12,true)<=32;
  if(action===1)return n===12 && v.getUint32(8,true)>0 && v.getUint32(8,true)<=256;
  if(action===2)return n===12 && v.getUint32(8,true)!==0;
  if(action===4)return n===16 && v.getUint32(8,true)!==0 && v.getUint32(12,true)!==0;
  if(action===5)return n===8;
  if(action!==3 || n<12)return false;
  const count=v.getUint32(8,true);
  if(!count || count>256 || n!==12+count*32)return false;
  for(let p=12;p<n;p+=32)if(!v.getUint32(p,true) || v.getUint32(p+4,true)>=256 ||
    !safeCounter(v,p+8) || !safeCounter(v,p+16))return false;
  return true;
}
/** Lifecycle authority grants only publication and recovery of cold-reserved
 * metadata. Creation, capture registration and native execution keep their
 * independent current-thread gates. */
export function validProgramJournalBarrierRequest(input:Uint8Array,outputBytes:number):boolean {
  if(!validProgramJournalRequest(input,outputBytes))return false;
  const action=new DataView(input.buffer,input.byteOffset,input.byteLength).getUint32(0,true);
  return action===3 || action===6 || action===7;
}
function u64(words:Uint32Array,at:number,value:number):void {words[at]=value>>>0;words[at+1]=Math.floor(value/0x1_0000_0000);}
function snapshot(words:Uint32Array,b:GlBinding,journal:GlProgramJournal|null):void {
  u64(words,5,programJournalSequence(b));u64(words,7,journal?.publishedTicket??0);u64(words,9,journal?.executedTicket??0);
  words[11]=MAGIC;
}

/** Ordinary queries keep own-current-TID authority; the lifecycle barrier
 * proves a live owned public context and restricts actions. Host-issued handles
 * scope peer metadata; selectors retain their own submitted-context authority. */
export function runProgramJournalQuery(b:GlBinding,input:Uint8Array,out:Uint8Array,execution?:GlContextExecutionLease):number {
  if(!validProgramJournalRequest(input,out.byteLength))return -22;
  const v=new DataView(input.buffer,input.byteOffset,input.byteLength),action=v.getUint32(0,true),control=b.programJournalControl;
  if(action===6){out.set(control.bytes);return 48;}
  if(action===7){
    const id=v.getUint32(4,true),journal=lookupProgramJournal(b,id),words=control.snapshot;
    words.fill(0);words[2]=7;words[3]=id;words[4]=journal?.flags??0;snapshot(words,b,journal);
    out.set(control.snapshotBytes);return 48;
  }
  if(action===8 || action===9){
    // The caller owns this context, not a peer journal's native reflection.
    // Reserve/zero the complete result before reflection and leave the sealed
    // mutation receipt untouched: a lost read may safely be retried.
    const id=v.getUint32(4,true),token=v.getUint32(8,true),words=control.snapshot;
    words.fill(0);words[0]=1;words[2]=action;words[3]=id;words[4]=token;
    words[5]=v.getUint32(12,true);words[11]=MAGIC;
    const journal=b.programJournal;
    if(journal?.id===id && journal.uniformSignature(token,v.getInt32(12,true),words,action===9))words[0]=0;
    out.set(control.snapshotBytes);return 48;
  }
  const tx=v.getUint32(4,true),words=control.receipt;
  // A lost response is reconciled through READ_LAST, never by retrying entry.
  // Status2 is reserved BEFORE effects and remains if execution throws.
  if(words[0]===2 || words[1]===0xffff_ffff || tx!==words[1]+1)return -22;
  words.fill(0);words[0]=2;words[1]=tx;words[2]=action;words[11]=MAGIC;
  let journal:GlProgramJournal|null=b.programJournal??null,value=0,accepted=false;
  const previous=b.errors;control.errors.length=0;b.errors=control.errors;
  try {
  if(action===1){
    if(execution && execution.binding===b && !execution.retired){
      journal=GlProgramJournal.create(execution,v.getUint32(8,true),"guest-metadata");accepted=!!journal;value=journal?.capacity??0;
    }else recordGlError(b,0x505);
  }else if(action===2){
    value=journal?.registerCapture(v.getUint32(8,true))??0;accepted=value!==0;
  }else if(action===3){
    const count=v.getUint32(8,true);let expected=programJournalSequence(b)+1,valid=true;
    // Preview cells live in the cold journal. No per-intent array/map/custody
    // allocation follows a guest's local API acceptance.
    try {
      for(let p=12;p<input.byteLength;p+=32){
        const target=lookupProgramJournal(b,v.getUint32(p,true));
        if(!target || !target.checkPublication(b,v.getUint32(p+4,true),journalInteger(v,p+8),journalInteger(v,p+16),
          v.getUint32(p+24,true),v.getUint32(p+28,true),expected++)){valid=false;break;}
      }
      if(valid){
        for(let p=12;p<input.byteLength;p+=32){
          const target=lookupProgramJournal(b,v.getUint32(p,true))!;
          if(!target.publish(b,v.getUint32(p+4,true),journalInteger(v,p+8),journalInteger(v,p+16),
              v.getUint32(p+24,true),v.getUint32(p+28,true)))nativeGlFault("Preflighted program journal publication lost its reserved state");
        }
        accepted=true;value=count;
      }
    }finally{
      for(let p=12;p<input.byteLength;p+=32)lookupProgramJournal(b,v.getUint32(p,true))?.clearPublicationCheck();
    }
  }else if(action===4){
    journal=lookupProgramJournal(b,v.getUint32(8,true));
    accepted=!!journal && (journal.flags&1)!==0 && journal.releaseCapture(v.getUint32(12,true));
    value=accepted?v.getUint32(12,true):0;
  }else if(action===5){accepted=!!journal && journal.disable();}
  else if(action===10){
    // Native allocation is cold but effectful. Use the sealed mutation ledger,
    // not the read-only signature reply: copyout loss recovers via READ_LAST.
    if(journal?.id===v.getUint32(8,true))value=journal.prepareBufferSnapshots(v.getUint32(12,true));
    accepted=value!==0;
  }
  if(!accepted && !b.errors.length)recordGlError(b,0x502);
  words[3]=journal?.id??0;words[4]=value;snapshot(words,b,journal);
  // Publish completion only after every progress field is sealed. A failed
  // copyout can then recover this exact receipt without replaying effects.
  words[0]=accepted?0:1;
  out.set(control.bytes);return 48;
  }catch(error){
    // WHY: a preflighted mutation that throws unexpectedly has lost a host
    // bookkeeping invariant. Returning EIO would leave a partially published
    // group looking usable. Preserve legitimate context-reset unwinds and
    // already reported faults; completed-receipt copyout remains recoverable.
    rethrowNativeGlFault(error);
    if(words[0]===2){
      let detail="unexpected exception";try{detail=String(error);}catch{}
      nativeGlFault(`Program journal transaction failed after entry: pid ${b.pid} session ${b.sessionId} transaction ${tx} action ${action}; ${detail}`,error);
    }
    throw error;
  }finally{
    b.errors=previous;
    if(rendererLost(b))previous.length=0;else for(const error of control.errors)recordGlError(b,error);
  }
}
