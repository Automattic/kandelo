import {recordCpuGlOutOfMemory} from "./errors.js";
/** Owned, bounded copies of small buffer definitions. A queued driver draw
 * must not depend on a public name or on storage a peer can replace later.
 * The ordinary logical buffer remains unchanged by these private copies.
 * This bank is prepared cold, then used only by its retained execution owner.
 */
import {BufferSnapshotDraw} from "./buffer-snapshot-draw.js";
import type {GlBinding,GlContextExecutionLease} from "./registry.js";
import {canonicalBuffer,replaceBufferData,prepareBufferDraw,withBufferTransfer} from "./buffer-storage.js";
import {checkedGlCall,recordGlError} from "./program-objects.js";
import {predictsNativeCalls,predictedNativeCalls,withNativeBookkeeping} from "./native-batch.js";
import {rendererLost,rendererLossCount,shareRendererLossAuthority} from "./renderer-loss.js";
import {applyNativeChanges,nativeInverse,nativeGlFault,reserveNativeRetirement,retireNativeRetirement,
  PreparedNativeChanges,prepareNativeInverse,prepareNativeCall,checkedPreparedNativeCall,
  rethrowNativeGlFault,type NativeRetirement,type NativeCall} from "./native-recovery.js";
import {activeVertexArray} from "./buffer-references.js";
import {packedVertexLayout} from "./vertex-data.js";
import {isKernelExportFailure} from "../kernel-entry-gate.js";

export const BUFFER_SNAPSHOT_CAPACITY=32;
export const BUFFER_SNAPSHOT_MAX_BYTES=32768;
const ARRAY=0x8892;
type Cell={native:WebGLBuffer|null;object:WebGLBuffer|null;token:number;bytes:number;ready:boolean};

/** Receivers and deletion custody precede every native allocation. Keep the
 * reserved bank in its manager even when initialize/retire fails. Reusing a
 * cell is an ordered execution operation, never an asynchronous pin eviction.
 * Callers resolve and issue the draw on the same synchronous command stack.
 */
export class GlBufferSnapshots {
  private execution:GlContextExecutionLease|null=null;
  private phase:"reserved"|"initializing"|"ready"|"failed"|"closed"="reserved";
  private readonly epoch:number;
  private readonly objects:GlBinding["objects"];
  private readonly contextId:GlBinding["contextId"];
  private retirement:NativeRetirement|null=null;
  private readonly drawView:GlBinding;
  readonly drawWorkspace:BufferSnapshotDraw;
  private readonly definition:PreparedNativeChanges;
  private readonly definitionRestore:NativeCall;
  private definitionData:number|Uint8Array<ArrayBuffer>|null=null;
  private definitionUsage=0;
  private definitionLength=0;
  private readonly uploadScratch=new Uint8Array(BUFFER_SNAPSHOT_MAX_BYTES);
  private definitionCell:Cell|null=null;
  private definitionObject:WebGLBuffer|null=null;
  private originalDefinitionAccepted=false;
  private constructor(readonly binding:GlBinding,private readonly cells:Cell[]){
    this.epoch=rendererLossCount(binding.gl!);
    this.objects=binding.objects;this.contextId=binding.contextId;
    // Only a fully range-proven snapshot draw borrows this view. The ordinary
    // robust path reads mutable public storage, which a peer may have shrunk;
    // letting it substitute that store would replace our retained bytes.
    this.drawView=Object.create(binding,{robustAccess:{value:false}}) as GlBinding;
    shareRendererLossAuthority(binding,this.drawView);
    this.drawWorkspace=new BufferSnapshotDraw(binding);
    const b=binding,gl=b.gl!;
    this.definitionRestore=["bindBuffer",ARRAY,null];
    const inverse=prepareNativeInverse(b,[this.definitionRestore]);
    if(!inverse)throw new Error("Unable to reserve buffer definition inverse");
    const select=prepareNativeCall(gl,["bindBuffer",ARRAY,null]);
    const upload=()=>{const data=this.definitionData!;
      if(typeof data==="number"||this.definitionLength===0)gl.bufferData(ARRAY,this.definitionLength,this.definitionUsage);
      else gl.bufferData(ARRAY,data,this.definitionUsage,0,this.definitionLength);};
    const uploads=[upload],issue=()=>predictsNativeCalls(b)?predictedNativeCalls(uploads):checkedGlCall(b,upload);
    const receiver=PreparedNativeChanges.reserve(b,[{apply:()=>{
      if(!replaceBufferData(b,ARRAY,this.definitionData!,this.definitionUsage,issue,this.definitionLength))return false;
      this.originalDefinitionAccepted=true;
      if(!this.definitionObject)nativeGlFault("Accepted buffer definition lost its bound identity");
      (select.call as ["bindBuffer",number,WebGLBuffer|null])[2]=this.definitionCell!.native;
      return checkedPreparedNativeCall(b,select)&&issue();
    },restore:inverse}],{finalizer:inverse});
    if(!receiver)throw new Error("Unable to reserve buffer definition receiver");this.definition=receiver;
  }
  get capacity():number {return this.cells.length;}

  static reserve(binding:GlBinding,capacity=BUFFER_SNAPSHOT_CAPACITY):GlBufferSnapshots|null {
    if(!binding.gl || binding.contextId===null || rendererLost(binding) || !Number.isInteger(capacity) || capacity<1 || capacity>BUFFER_SNAPSHOT_CAPACITY)return null;
    try {
      const cells=Array.from({length:capacity},():Cell=>({native:null,object:null,token:0,bytes:0,ready:false}));
      const calls=cells.map(()=>["deleteBuffer",null] as ["deleteBuffer",WebGLBuffer|null]);
      const bank=new GlBufferSnapshots(binding,cells);
      const retirement=reserveNativeRetirement(binding,calls);
      if(!retirement)return null;
      bank.retirement=retirement;return bank;
    } catch(error) {
      rethrowNativeGlFault(error);if(isKernelExportFailure(error))throw error;
      recordCpuGlOutOfMemory(binding);return null;
    }
  }

  initialize(execution:GlContextExecutionLease):boolean {
    if(this.phase!=="reserved")return this.phase==="ready" && !execution.retired && execution.context===this.binding.gl && this.owns(execution.binding);
    if(execution.binding!==this.binding || execution.retired || execution.context!==this.binding.gl || rendererLost(this.binding) ||
      this.binding.objects!==this.objects || this.binding.contextId!==this.contextId)return false;
    this.phase="initializing";
    try {
      this.execution=execution.clone();
      if(!this.execution){recordCpuGlOutOfMemory(this.binding);return false;}
      const b=this.binding,gl=b.gl!;
      const ready=withNativeBookkeeping(()=>{
        for(let i=0;i<this.cells.length;i++) {
          const cell=this.cells[i]!;
          if(!checkedGlCall(b,()=>{
            cell.native=gl.createBuffer();
            this.retirement!.calls[i]![1]=cell.native;
          }))return false;
          if(!cell.native){recordGlError(b,0x505);return false;}
        }
        return true;
      });
      if(!ready)return false;
      this.phase="ready";return true;
    } finally {if(this.phase==="initializing")this.phase="failed";}
  }

  private owns(authority:GlBinding):boolean {
    return this.phase==="ready" && authority===this.binding && !!this.execution &&
      !this.execution.retired && authority.gl===this.execution.context &&
      authority.objects===this.objects && authority.contextId===this.contextId && !rendererLost(authority) &&
      rendererLossCount(authority.gl!)===this.epoch;
  }

  /** The new record carries the original BufferData operands. Independent
   * host validation runs first; only an accepted definition produces a copy.
   * As for ordinary buffer commands, the executor selects this context before
   * entry; the retained lease does not silently select a foreign native owner.
   * Native OOM uses the surrounding batch's reset policy. A bookkeeping or
   * inverse failure after API acceptance is fatal and retains its owner.
   */
  define(authority:GlBinding,index:number,token:number,target:number,data:number|Uint8Array<ArrayBuffer>,usage:number):boolean {
    return this.defineData(authority,index,token,target,data,usage,typeof data==="number"?data:data.byteLength);
  }
  /** Copy the already frozen wire bytes into cold storage. A new ArrayBuffer
   * or typed-array view here could fail after C had answered NO_ERROR locally.
   * WebGL2's source range uploads exactly this definition, not the capacity. */
  defineFromWire(authority:GlBinding,index:number,token:number,target:number,wire:DataView,offset:number,bytes:number,usage:number):boolean {
    if(!Number.isInteger(bytes)||bytes<0||bytes>this.uploadScratch.length||!Number.isInteger(offset)||offset<0||offset+bytes>wire.byteLength){recordGlError(authority,0x502);return false;}
    for(let i=0;i<bytes;i++)this.uploadScratch[i]=wire.getUint8(offset+i);
    return this.defineData(authority,index,token,target,this.uploadScratch,usage,bytes);
  }
  private defineData(authority:GlBinding,index:number,token:number,target:number,data:number|Uint8Array<ArrayBuffer>,usage:number,bytes:number):boolean {
    if(!this.owns(authority) || !Number.isInteger(index) || index<0 || index>=this.cells.length ||
      !Number.isInteger(token) || token<1 || token>0xffff_ffff || target!==ARRAY ||
      !Number.isInteger(bytes) || bytes<0 || bytes>BUFFER_SNAPSHOT_MAX_BYTES) {
      recordGlError(authority,0x502);return false;
    }
    const cell=this.cells[index]!;
    if(cell.token===0xffff_ffff || token!==cell.token+1){recordGlError(authority,0x502);return false;}
    // Consume the attempt before the independently validated mutation. A
    // rejected definition never exposes a preceding copy under its new token.
    cell.token=token;cell.ready=false;cell.object=null;cell.bytes=0;
    const b=this.binding,array=b.shadow.arrayBuffer,object=array&&canonicalBuffer(b,array);
    // Admission reserved this receiver and its upload closures. Never discover
    // CPU bookkeeping exhaustion after the ordinary BufferData has mutated.
    this.definitionData=data;this.definitionUsage=usage;this.definitionLength=bytes;this.definitionCell=cell;this.definitionObject=object;
    this.definitionRestore[2]=array;this.originalDefinitionAccepted=false;
    let copied=false;
    try{copied=this.definition.apply();}
    finally{this.definitionData=null;this.definitionCell=null;this.definitionObject=null;}
    if(!copied){
      if(this.originalDefinitionAccepted)nativeGlFault("Accepted buffer definition could not retain its private storage copy");
      return false;
    }
    cell.object=object;cell.bytes=bytes;cell.ready=true;return true;
  }

  /** Cold capture is by the caller's actual retained attribute, never by a
   * GLuint lookup. A source defined before journal admission still needs real
   * bytes. Zero is a completed unavailable result, not a new guest API error.
   */
  captureAttribute(authority:GlBinding,index:number,token:number,attribute:number):number|null {
    if(!this.owns(authority) || !Number.isInteger(index) || index<0 || index>=this.cells.length ||
      !Number.isInteger(token) || token<1 || token>0xffff_ffff || !Number.isInteger(attribute) || attribute<0 || attribute>=16){
      recordGlError(authority,0x502);return null;
    }
    const cell=this.cells[index]!;
    if(cell.token===0xffff_ffff || token!==cell.token+1){recordGlError(authority,0x502);return null;}
    cell.token=token;cell.ready=false;cell.object=null;cell.bytes=0;
    const b=this.binding,a=activeVertexArray(b).attributes.get(attribute),object=a?.buffer;
    const store=object&&b.bufferStores.get(object);
    if(!a?.enabled || !object || !store || a.view || packedVertexLayout(a) ||
      store.size<=0 || store.size>BUFFER_SNAPSHOT_MAX_BYTES)return 0;
    if(!prepareBufferDraw(b,false))return null;
    const source=store.views.get(ARRAY);
    if(!source?.valid)return 0;
    if(!withBufferTransfer(b,source.native,cell.native!,()=>
      checkedGlCall(b,()=>b.gl!.bufferData(0x8f37,store.size,0x88e4)) &&
      checkedGlCall(b,()=>b.gl!.copyBufferSubData(0x8f36,0x8f37,0,0,store.size))))return null;
    cell.object=object;cell.bytes=store.size;cell.ready=true;return cell.bytes;
  }

  /** Own-context only; the view borrows the bank's execution lease and shares
   * the original error/reset identity. It adds no work to ordinary draws. */
  executionView(authority:GlBinding):GlBinding|null {return this.owns(authority)?this.drawView:null;}

  /** Borrow only for the synchronous draw currently being executed. Names
   * are intentionally absent: deletion and numeric reuse cannot retarget it.
   * A caller must not retain this native handle across later bank operations.
   */
  resolve(authority:GlBinding,index:number,token:number,object:WebGLBuffer,requiredBytes:number):WebGLBuffer|null {
    if(!this.owns(authority) || !Number.isInteger(index) || index<0 || index>=this.cells.length ||
      !Number.isSafeInteger(requiredBytes) || requiredBytes<0)return null;
    const cell=this.cells[index]!;
    return cell.ready && cell.token===token && cell.object===object && requiredBytes<=cell.bytes?cell.native:null;
  }

  retire():boolean {
    this.phase="closed";
    if(this.retirement && !retireNativeRetirement(this.retirement))return false;
    for(const cell of this.cells){cell.native=null;cell.object=null;cell.ready=false;}
    if(this.execution && !this.execution.release())return false;
    this.execution=null;return true;
  }
}
