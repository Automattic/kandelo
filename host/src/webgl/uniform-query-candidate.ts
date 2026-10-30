import { isKernelExportFailure } from "../kernel-entry-gate.js";
import type { GlBinding, GlContextExecutionLease } from "./registry.js";
import { GlProgramQueryPin, checkedGlCall, programLinkGeneration, recordGlError } from "./program-objects.js";
import { GlUniformLookup, replaceUniformLookup, reserveUniformLocation, type GlUniformLocationReservation } from "./uniform-queries.js";
import type { GlUniformLookupBytes } from "./uniform-lookup-bytes.js";
import * as O from "./ops.js";

const EMPTY=new Uint8Array(0);
type Stage = {kind:"none"} | {kind:"replace";next:GlUniformLookup|null;serial:number}
  | {kind:"chunk";pending:GlUniformLookup;offset:number;data:GlUniformLookupBytes};

/** Prepared once at the captured operation-stream head. No guest view enters
 * this owner. Publication only changes already allocated objects; retirement
 * keeps the exact context/executable leases until native cleanup succeeds. */
export class GlUniformQueryCandidate {
  private decision:"none"|"publish"|"cancel"="none";
  private accepted=false;
  private pin:GlProgramQueryPin|null=null;
  private reservation:GlUniformLocationReservation|null=null;
  private stage:Stage={kind:"none"};
  private resultCode:number;
  private readonly sourcePid:number;
  private readonly sourceSession:number;
  private readonly sourceContext:number|null;
  private readonly sourceObjects:GlBinding["objects"];
  private expected:GlUniformLookup|null;
  private expectedSerial:number;
  private expectedCursor:number;
  private constructor(private execution:GlContextExecutionLease|null,
      private owner:GlBinding|null, private reply:GlUniformLookupBytes|null, readonly op:number) {
    this.resultCode=op===O.QOP_GET_UNIFORM_LOC?4:16;
    this.sourcePid=owner!.pid;this.sourceSession=owner!.sessionId;this.sourceContext=owner!.contextId;this.sourceObjects=owner!.objects;
    this.expected=owner!.uniformLookup;this.expectedSerial=owner!.uniformLookupSerial;
    this.expectedCursor=this.expected?.cursor??0;
  }
  get result():number {return this.resultCode;}
  get awaitingPublication():boolean {return this.decision==="none" && this.owner!==null;}
  matchesExecution(execution:GlContextExecutionLease):boolean {
    try {return this.owner!==null && execution.binding===this.owner && execution.context===this.owner.gl
      && this.owner.pid===this.sourcePid && this.owner.sessionId===this.sourceSession
      && this.owner.contextId===this.sourceContext && this.owner.objects===this.sourceObjects;}
    catch (error) { if(isKernelExportFailure(error)) throw error;return false;}
  }
  get retirementComplete():boolean {return this.owner===null && this.execution===null && this.pin===null && this.reply===null;}
  /** Adapter copies these bounded bytes into its retained Ready result once. */
  get bytes():Uint8Array<ArrayBuffer> {return this.resultCode<0?EMPTY:this.reply?.bytes??EMPTY;}

  static prepare(execution:GlContextExecutionLease,op:number,input:Uint8Array,capacity:number):GlUniformQueryCandidate|null {
    if(input.byteLength>65536 || !Number.isSafeInteger(capacity) || capacity<0 || capacity>65536) return null;
    if(op===O.QOP_GET_UNIFORM_LOC) {
      if(input.length<8 || capacity<4 || new DataView(input.buffer,input.byteOffset,input.byteLength).getUint32(4,true)>input.length-8) return null;
    } else if(op===O.QOP_LOOKUP_UNIFORM) {
      if(input.length<16 || capacity<16) return null;
      const v=new DataView(input.buffer,input.byteOffset,input.byteLength),action=v.getUint32(0,true),token=v.getUint32(8,true),arg=v.getUint32(12,true);
      if(action>4 || !token || ((action===1 || action>=3)&&input.length!==16)
        || (action>=3 && arg!==0) || (action===2 && input.length===16) || (action===0 && arg!==input.length-16)) return null;
    } else return null;
    const b=execution.binding,retained=execution.clone();
    if(!retained) {recordGlError(b,0x505);return null;}
    const reply=b.uniformLookupBudget.allocate(op===O.QOP_GET_UNIFORM_LOC?4:16);
    if(!reply) {retained.release();recordGlError(b,0x505);return null;}
    let candidate:GlUniformQueryCandidate;
    try {candidate=new GlUniformQueryCandidate(retained,b,reply,op);}
    catch (error) { if(isKernelExportFailure(error)) throw error;reply.release();retained.release();recordGlError(b,0x505);return null;}
    try {candidate.prepare(input);}
    catch (error) { if(isKernelExportFailure(error)) throw error;candidate.fail(0x505);}
    return candidate;
  }

  private fail(error?:number):void {
    this.reservation?.cancel();this.reservation=null;
    if(this.stage.kind==="chunk") {this.stage.data.release();this.stage={kind:"none"};}
    else if(this.stage.kind==="replace" && this.stage.next) {this.stage.next.release();this.stage={kind:"none"};}
    if(error)recordGlError(this.owner!,error);
    if(this.op===O.QOP_GET_UNIFORM_LOC) this.resultCode=-22;
    else {
      this.reply!.bytes.fill(0);
      const v=new DataView(this.reply!.bytes.buffer);v.setUint32(0,1,true);v.setUint32(12,0x47514c33,true);
    }
  }
  private captureProgram(name:number,expected?:GlUniformLookup):WebGLProgram|null {
    const b=this.owner!;
    this.pin=GlProgramQueryPin.acquire(this.execution!,name);
    if(!this.pin) {this.fail();return null;}
    const program=this.pin.program;
    if(expected && (program!==expected.executable || programLinkGeneration(b,program).value!==expected.generation)) {
      this.stage={kind:"replace",next:null,serial:this.expectedSerial};
      this.fail(0x502);return null;
    }
    let linked=false;
    if(!checkedGlCall(b,()=>{linked=!!b.gl!.getProgramParameter(program,0x8b82);})) {this.fail();return null;}
    if(!linked) {this.fail(0x502);return null;}
    return program;
  }
  private resolve(name:number,program:WebGLProgram,bytes:Uint8Array):number|null {
    const b=this.owner!,copy=b.uniformLookupBudget.allocate(bytes.byteLength);
    if(!copy) {this.fail(0x505);return null;}
    try {
      copy.bytes.set(bytes);
      this.reservation=reserveUniformLocation(b,name,new TextDecoder().decode(copy.bytes),program);
      if(!this.reservation) {this.fail();return null;}
      return this.reservation.index;
    } finally {copy.release();}
  }
  private prepare(input:Uint8Array):void {
    const b=this.owner!,v=new DataView(input.buffer,input.byteOffset,input.byteLength);
    if(this.op===O.QOP_GET_UNIFORM_LOC) {
      const name=v.getUint32(0,true),program=this.captureProgram(name);
      if(!program) return;
      const index=this.resolve(name,program,input.subarray(8,8+v.getUint32(4,true)));
      if(index!==null)new DataView(this.reply!.bytes.buffer).setInt32(0,index,true);
      return;
    }
    const action=v.getUint32(0,true),name=v.getUint32(4,true),token=v.getUint32(8,true),arg=v.getUint32(12,true);
    let location=-1;
    if(action<=1) {
      if(token<=this.expectedSerial) {this.fail(0x502);return;}
      const program=this.captureProgram(name);if(!program)return;
      if(action===0) {
        const index=this.resolve(name,program,input.subarray(16));if(index===null)return;
        location=index;this.stage={kind:"replace",next:null,serial:token};
      } else {
        const storage=b.uniformLookupBudget.allocate(arg);
        if(!storage) {this.fail(0x505);return;}
        try {
          const next=new GlUniformLookup(name,program,programLinkGeneration(b,program).value,token,storage);
          this.stage={kind:"replace",next,serial:token};
        } catch (error) { if(isKernelExportFailure(error)) throw error;storage.release();throw new Error("Uniform lookup staging allocation failed");}
      }
    } else if(action===4) {
      if(this.expected && (this.expected.token>token || (this.expected.token===token && this.expected.program!==name))) {this.fail(0x502);return;}
      this.stage={kind:"replace",next:null,serial:Math.max(this.expectedSerial,token)};
    } else {
      const pending=this.expected;
      if(!pending || pending.token!==token || pending.program!==name) {this.fail(0x502);return;}
      const program=this.captureProgram(name,pending);if(!program)return;
      if(action===2) {
        if(arg!==pending.cursor || input.length-16>pending.bytes.length-pending.cursor) {
          this.stage={kind:"replace",next:null,serial:this.expectedSerial};this.fail(0x502);return;
        }
        const data=b.uniformLookupBudget.allocate(input.length-16);
        if(!data) {this.fail(0x505);return;}
        data.bytes.set(input.subarray(16));this.stage={kind:"chunk",pending,offset:arg,data};
      } else {
        this.stage={kind:"replace",next:null,serial:this.expectedSerial};
        if(pending.cursor!==pending.bytes.length) {this.fail(0x502);return;}
        const index=this.resolve(name,program,pending.bytes);if(index===null)return;
        location=index;
      }
    }
    const reply=new DataView(this.reply!.bytes.buffer);reply.setUint32(4,token,true);reply.setInt32(8,location,true);reply.setUint32(12,0x47514c33,true);
  }

  publish():boolean {
    if(this.decision!=="none")return this.decision==="publish" && this.accepted;
    const b=this.owner!;
    this.decision="publish";
    if(!this.execution || !this.matchesExecution(this.execution)) return false;
    if(this.op===O.QOP_LOOKUP_UNIFORM && (b.uniformLookup!==this.expected || b.uniformLookupSerial!==this.expectedSerial
      || (this.expected && this.expected.cursor!==this.expectedCursor))) return false;
    this.reservation?.publish();this.reservation=null;
    if(this.stage.kind==="replace") {
      replaceUniformLookup(b,this.stage.next);b.uniformLookupSerial=this.stage.serial;
      this.stage={kind:"none"};
    } else if(this.stage.kind==="chunk") {
      this.stage.pending.bytes.set(this.stage.data.bytes,this.stage.offset);
      this.stage.pending.cursor+=this.stage.data.bytes.length;
    }
    this.expected=null;this.accepted=true;return true;
  }
  cancel():void {
    if(this.decision!=="none")return;
    this.decision="cancel";
  }
  retire():boolean {
    if(this.decision==="none")return false;
    this.reservation?.cancel();this.reservation=null;
    if(this.stage.kind==="replace")this.stage.next?.release();
    else if(this.stage.kind==="chunk")this.stage.data.release();
    this.stage={kind:"none"};this.expected=null;
    if(this.pin && !this.pin.release())return false;
    this.pin=null;
    if(this.execution && !this.execution.release())return false;
    this.execution=null;this.owner=null;this.reply?.release();this.reply=null;
    return true;
  }
}
export function prepareGlUniformQuery(execution:GlContextExecutionLease,op:number,input:Uint8Array,capacity:number):GlUniformQueryCandidate|null {
  return GlUniformQueryCandidate.prepare(execution,op,input,capacity);
}
