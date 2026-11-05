import { GL_CLIENT_ERROR_MASK, type GlErrorState } from "./errors.js";
import { GL_QUERY_REPLY_MAGIC } from "../generated/abi.js";
import {nativeGlFault} from "./native-recovery.js";
import {
  GL_ERROR_DRAIN_CAPACITY, GL_ERROR_DRAIN_REPLY_BYTES, GL_ERROR_DRAIN_REQUEST, GL_ERROR_DRAIN_REQUEST_BYTES,
  GL_ERROR_DRAIN_RECEIPT_REQUEST,GL_ERROR_DRAIN_RECEIPT_BYTES,
} from "./ops.js";

export type GlErrorQuery = { mask: number; drain: boolean; transaction?:number };
/** One cold, context-owned result. Serial calls allow a wrapping u32 identity:
 * only its successor may enter, and only the latest result can be recovered. */
export class GlErrorDrainReceipt {
  readonly words=new Uint32Array(GL_ERROR_DRAIN_RECEIPT_BYTES/4);
  readonly bytes=new Uint8Array(this.words.buffer);
  valid=false;
  reset():void {this.valid=false;this.words.fill(0);}
  next(transaction:number):boolean {
    return (!this.valid || this.words[0]===0) && transaction===((this.words[1]!+1)>>>0);
  }
  read(transaction:number,out:Uint8Array):number {
    if(out.length!==this.bytes.length)return -22;
    if(this.valid&&transaction===this.words[1]){out.set(this.bytes);return out.length;}
    if(!this.next(transaction))return -22;
    out.fill(0);const v=new DataView(out.buffer,out.byteOffset,out.byteLength);
    v.setUint32(0,1,true);v.setUint32(4,transaction,true);
    v.setUint32(out.length-4,GL_QUERY_REPLY_MAGIC,true);return out.length;
  }
}

/** QOP_GET_ERROR input. The optional fallback mask uses the same five ES2
 * flags as command trailers. Empty or 4-byte input pops one flag (legacy);
 * the 8-byte [mask, GL_ERROR_DRAIN_REQUEST] form drains every flag. */
export function readGlErrorQuery(input: Uint8Array): GlErrorQuery | null {
  const length = input.byteLength;
  if (length !== 0 && length !== 4 && length !== GL_ERROR_DRAIN_REQUEST_BYTES && length!==12) return null;
  const view = new DataView(input.buffer, input.byteOffset, length);
  const mask = length ? view.getUint32(0, true) : 0;
  if (mask & ~GL_CLIENT_ERROR_MASK) return null;
  if(length===12)return view.getUint32(4,true)===GL_ERROR_DRAIN_RECEIPT_REQUEST
    ? {mask,drain:true,transaction:view.getUint32(8,true)} : null;
  if (length !== GL_ERROR_DRAIN_REQUEST_BYTES) return { mask, drain: false };
  return view.getUint32(4, true) === GL_ERROR_DRAIN_REQUEST ? { mask, drain: true } : null;
}

/** Reserve the receipt before removing a flag, seal after the complete
 * transfer, then copy out. Copyout failure retains the sealed result. */
export function drainGlErrorsWithReceipt(owner:GlErrorState&{pid:number;sessionId:number;errorDrainReceipt:GlErrorDrainReceipt},transaction:number,out:Uint8Array):number {
  const cell=owner.errorDrainReceipt;
  if(!cell.next(transaction)||out.length!==cell.bytes.length)return -22;
  const w=cell.words;w.fill(0);w[0]=2;w[1]=transaction;w[12]=GL_QUERY_REPLY_MAGIC;cell.valid=true;
  try{
    const count=Math.min(owner.errors.length,GL_ERROR_DRAIN_CAPACITY);
    w[2]=count;w[3]=owner.errors.length>count?1:0;
    for(let i=0;i<count;i++)w[4+i]=owner.errors[i]!;
    owner.errors.splice(0,count);
    w[0]=0;
  }catch(error){nativeGlFault(`error drain bookkeeping failed for pid ${owner.pid} session ${owner.sessionId} transaction ${transaction}`,error);}
  out.set(cell.bytes);return out.length;
}

/** The drain form exists so a guest can answer glGetError without a round
 * trip (ES 2.0 section 2.5: each recorded flag is reported once, in any
 * order). A reply with retained=0 transfers custody of the complete error
 * state; the guest then reports those flags itself until it sends this
 * context more work. Moving flags out in recording order keeps the order
 * the legacy one-at-a-time pop would have produced. The owner array is
 * mutated in place because the muxer may alias it as its error owner. */
export function drainGlErrors(owner: GlErrorState, out: Uint8Array): number {
  const view = new DataView(out.buffer, out.byteOffset, GL_ERROR_DRAIN_REPLY_BYTES);
  const moved = owner.errors.splice(0, GL_ERROR_DRAIN_CAPACITY);
  out.fill(0, 0, GL_ERROR_DRAIN_REPLY_BYTES);
  view.setUint32(0, moved.length, true);
  view.setUint32(4, owner.errors.length ? 1 : 0, true);
  moved.forEach((error, index) => view.setUint32(8 + 4 * index, error, true));
  view.setUint32(GL_ERROR_DRAIN_REPLY_BYTES - 4, GL_QUERY_REPLY_MAGIC, true);
  return GL_ERROR_DRAIN_REPLY_BYTES;
}
