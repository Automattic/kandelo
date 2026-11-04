import {rendererLost} from "./renderer-loss.js";
import type {GlBinding,GlContextExecutionLease} from "./registry.js";
import {GlProgramJournal,lookupProgramJournal,programJournalSequence} from "./program-journal.js";
import {recordGlError} from "./errors.js";
import {nativeGlFault} from "./native-recovery.js";

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
function u64(words:Uint32Array,at:number,value:number):void {words[at]=value>>>0;words[at+1]=Math.floor(value/0x1_0000_0000);}
function snapshot(words:Uint32Array,b:GlBinding,journal:GlProgramJournal|null):void {
  u64(words,5,programJournalSequence(b));u64(words,7,journal?.publishedTicket??0);u64(words,9,journal?.executedTicket??0);
  words[11]=MAGIC;
}

/** The Rust outer query retains ordinary own-current-TID authority. Host-issued
 * journal handles restrict peer metadata to live same-process/group owners;
 * selector execution remains confined to its own submitted context. */
export function runProgramJournalQuery(b:GlBinding,input:Uint8Array,out:Uint8Array,execution?:GlContextExecutionLease):number {
  if(!validProgramJournalRequest(input,out.byteLength))return -22;
  const v=new DataView(input.buffer,input.byteOffset,input.byteLength),action=v.getUint32(0,true),control=b.programJournalControl;
  if(action===6){out.set(control.bytes);return 48;}
  if(action===7){
    const id=v.getUint32(4,true),journal=lookupProgramJournal(b,id),words=control.snapshot;
    words.fill(0);words[2]=7;words[3]=id;words[4]=journal?.flags??0;snapshot(words,b,journal);
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
  if(!accepted && !b.errors.length)recordGlError(b,0x502);
  words[0]=accepted?0:1;words[3]=journal?.id??0;words[4]=value;snapshot(words,b,journal);
  out.set(control.bytes);return 48;
  }finally{
    b.errors=previous;
    if(rendererLost(b))previous.length=0;else for(const error of control.errors)recordGlError(b,error);
  }
}
