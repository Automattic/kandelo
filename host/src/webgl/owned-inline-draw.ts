/** Cold upload and recovery storage for locally accepted client-array draws. */
import type {GlBinding,GlContextExecutionLease} from "./registry.js";
import type {GlesDraw} from "./draw-state.js";
import {activeVertexArray} from "./buffer-references.js";
import {packedVertexLayout} from "./vertex-data.js";
import {shareRendererLossAuthority,rendererLost,rendererLossCount} from "./renderer-loss.js";
import {checkedGlCall,recordGlError} from "./program-objects.js";
import {predictsNativeCalls,predictedNativeCalls,withNativeBookkeeping} from "./native-batch.js";
import {recordCpuGlOutOfMemory} from "./errors.js";
import {PreparedNativeChanges,prepareNativeCall,prepareNativeInverse,checkedPreparedNativeCall,
  reserveNativeRetirement,retireNativeRetirement,rethrowNativeGlFault,nativeGlFault,
  type NativeCall,type NativeRetirement,type PreparedNativeCall,type PreparedNativeInverse} from "./native-recovery.js";

export const OWNED_INLINE_HEADER_BYTES=28;
const ROW=20,CAPACITY=65535,ATTRIBUTES=16,ARRAY=0x8892,STREAM=0x88e0,FLOAT=0x1406,FIXED=0x140c;
export type OwnedInlineAuthority={readonly executionView:GlBinding;issue(draw:GlesDraw):boolean};
type Row={index:number;size:number;type:number;normalized:boolean;element:number;bytes:number;source:number;scratch:number;region:number};
function width(type:number):number{return type===0x1400||type===0x1401?1:type===0x1402||type===0x1403?2:type===FLOAT||type===FIXED?4:0;}
/** journal, ready cell/token, mode, first/count, row count; sorted ordinary
 * inline rows follow. Shape preflight allocates no parser objects and resolves
 * no name, so a malformed trailing row cannot expose an earlier draw. */
function validRows(v:DataView,header:number,mode:number,first:number,count:number,n:number):boolean {
  if(v.byteLength<header||v.byteLength>CAPACITY||mode>6||first<0||count<=0||!n||n>ATTRIBUTES)return false;
  let p=header,previous=-1;
  for(let i=0;i<n;i++){
    if(p+ROW>v.byteLength)return false;
    const index=v.getUint32(p,true),size=v.getUint32(p+4,true),type=v.getUint32(p+8,true),w=width(type),bytes=v.getUint32(p+16,true);
    if(index<=previous||index>=ATTRIBUTES||size<1||size>4||!w||v.getUint32(p+12,true)>1||bytes!==count*size*w||
      (first+count)*size*w>0x7fffffff||p+ROW+bytes>v.byteLength)return false;
    previous=index;p+=ROW+bytes;
  }
  return p===v.byteLength;
}
export function validPreparedInlineBody(v:DataView):boolean {
  return v.byteLength>=16&&validRows(v,16,v.getUint32(0,true),v.getInt32(4,true),v.getInt32(8,true),v.getUint32(12,true));
}
export function validPreparedInlineDraw(v:DataView):boolean {
  return v.byteLength>=OWNED_INLINE_HEADER_BYTES&&!!v.getUint32(0,true)&&v.getUint32(4,true)<16&&!!v.getUint32(8,true)&&
    validRows(v,OWNED_INLINE_HEADER_BYTES,v.getUint32(12,true),v.getInt32(16,true),v.getInt32(20,true),v.getUint32(24,true));
}
/** The rare maximum-size body keeps its original16-byte header. Positive
 * copied bytes already imply count<=65535; packing only those bounded fields
 * preserves the full GLfirst, journal and generation token without a new cap. */
export function validPreparedInlineCompact(v:DataView):boolean {
  if(v.byteLength<16)return false;
  const word=v.getUint32(0,true);
  return !(word&0xe0000000)&&((word>>>8)&31)<16&&!!v.getUint32(8,true)&&!!v.getUint32(12,true)&&
    validRows(v,16,word&7,v.getInt32(4,true),(word>>>13)&65535,(word>>>3)&31);
}

export class GlInlineDraws {
  private execution:GlContextExecutionLease|null=null;
  private phase:"reserved"|"initializing"|"ready"|"failed"|"closed"="reserved";
  private readonly objects:GlBinding["objects"];
  private readonly contextId:GlBinding["contextId"];
  private readonly epoch:number;
  private readonly view:GlBinding;
  private readonly scratch=new Uint8Array(CAPACITY);
  private readonly scratchView=new DataView(this.scratch.buffer);
  private readonly rows:Row[]=Array.from({length:ATTRIBUTES},()=>({index:0,size:0,type:0,normalized:false,element:0,bytes:0,source:0,scratch:0,region:0}));
  private readonly pointers:PreparedNativeCall[]=[];
  private readonly restoreCalls:NativeCall[]=[];
  private readonly inverse:PreparedNativeInverse;
  private readonly select:PreparedNativeCall;
  private readonly receiver:PreparedNativeChanges;
  private retirement:NativeRetirement|null=null;
  private stream:WebGLBuffer|null=null;
  private proof:OwnedInlineAuthority|null=null;
  private first=0;private count=0;private n=0;private total=0;private copied=0;
  private readonly draw:GlesDraw;
  private readonly uploads:readonly (()=>void)[];
  private constructor(readonly binding:GlBinding){
    const b=binding,gl=b.gl!;this.objects=b.objects;this.contextId=b.contextId;this.epoch=rendererLossCount(gl);
    this.view=Object.create(b,{robustAccess:{value:false}}) as GlBinding;shareRendererLossAuthority(b,this.view);
    this.select=prepareNativeCall(gl,["bindBuffer",ARRAY,null]);
    this.restoreCalls.push(["bindBuffer",ARRAY,null]);
    for(let i=0;i<ATTRIBUTES;i++){
      this.pointers.push(prepareNativeCall(gl,["vertexAttribPointer",i,4,FLOAT,false,0,0]));
      this.restoreCalls.push(["vertexAttribPointer",i,4,FLOAT,false,0,0]);
    }
    this.restoreCalls.push(["bindBuffer",ARRAY,null]);
    const inverse=prepareNativeInverse(b,this.restoreCalls),empty=prepareNativeInverse(b);
    if(!inverse||!empty)throw new Error("Unable to reserve owned inline inverse");this.inverse=inverse;
    this.draw={mode:0,observed:false,maxVertex:0,issue:()=>gl.drawArrays(this.draw.mode,this.first,this.count),
      vertices:()=>nativeGlFault("Prepared inline draw requested an unreserved CPU index plan")};
    this.uploads=[()=>{
      // A nonzero first needs GPU prefix space, not a CPU copy of that unused
      // prefix. Preserve the actual first operand and native vertex numbering.
      if(this.first===0)gl.bufferData(ARRAY,this.scratch,STREAM,0,this.copied);
      else{
        gl.bufferData(ARRAY,this.total,STREAM);
        for(let i=0;i<this.n;i++){
          const row=this.rows[i];gl.bufferSubData(ARRAY,row.region+this.first*row.element,this.scratch,row.scratch,row.bytes);
        }
      }
    }];
    const upload=()=>predictsNativeCalls(b)?predictedNativeCalls(this.uploads):checkedGlCall(b,this.uploads[0]);
    const receiver=PreparedNativeChanges.reserve(b,[{apply:()=>{
      if(!checkedPreparedNativeCall(b,this.select)||!upload())return false;
      for(let i=0;i<this.n;i++)if(!checkedPreparedNativeCall(b,this.pointers[i]))return false;
      return true;
    },restore:inverse},{apply:()=>this.proof!.issue(this.draw),restore:empty}],{finalizer:inverse});
    if(!receiver)throw new Error("Unable to reserve owned inline receiver");this.receiver=receiver;
  }
  static reserve(binding:GlBinding):GlInlineDraws|null {
    if(!binding.gl||binding.contextId===null||rendererLost(binding))return null;
    try{
      const bank=new GlInlineDraws(binding),retirement=reserveNativeRetirement(binding,[["deleteBuffer",null]]);
      if(!retirement)return null;bank.retirement=retirement;return bank;
    }catch(error){rethrowNativeGlFault(error);recordCpuGlOutOfMemory(binding);return null;}
  }
  initialize(execution:GlContextExecutionLease):boolean {
    if(this.phase!=="reserved")return this.phase==="ready"&&!execution.retired&&execution.context===this.binding.gl&&this.owns(execution.binding);
    if(execution.binding!==this.binding||execution.retired||execution.context!==this.binding.gl||rendererLost(this.binding))return false;
    this.phase="initializing";
    try{
      this.execution=execution.clone();if(!this.execution){recordCpuGlOutOfMemory(this.binding);return false;}
      const b=this.binding;
      if(!withNativeBookkeeping(()=>checkedGlCall(b,()=>{this.stream=b.gl!.createBuffer();this.retirement!.calls[0][1]=this.stream;})))return false;
      if(!this.stream){recordGlError(b,0x505);return false;}
      (this.select.call as ["bindBuffer",number,WebGLBuffer|null])[2]=this.stream;this.phase="ready";return true;
    }finally{if(this.phase==="initializing")this.phase="failed";}
  }
  private owns(b:GlBinding):boolean {
    return this.phase==="ready"&&b===this.binding&&!!this.execution&&!this.execution.retired&&this.execution.context===b.gl&&
      b.objects===this.objects&&b.contextId===this.contextId&&!rendererLost(b)&&rendererLossCount(b.gl!)===this.epoch;
  }
  executionView(b:GlBinding):GlBinding|null{return this.owns(b)?this.view:null;}
  /** The complete logical layout is checked before upload. Every scratch,
   * callback, native inverse and custody receiver was admitted cold; the wire
   * and proof are borrowed only on this synchronous stack and never retained. */
  drawPrepared(b:GlBinding,v:DataView,proof:OwnedInlineAuthority):boolean {
    if(!validPreparedInlineDraw(v)){recordGlError(b,0x502);return false;}
    return this.drawRecord(b,v,proof,false);
  }
  drawPreparedCompact(b:GlBinding,v:DataView,proof:OwnedInlineAuthority):boolean {
    if(!validPreparedInlineCompact(v)){recordGlError(b,0x502);return false;}
    return this.drawRecord(b,v,proof,true);
  }
  private drawRecord(b:GlBinding,v:DataView,proof:OwnedInlineAuthority,compact:boolean):boolean {
    if(!this.owns(b)||b.vertexArrayId!==0||b.savedClientArrayBuffer!==undefined){recordGlError(b,0x502);return false;}
    const word=v.getUint32(0,true),vao=activeVertexArray(b),n=compact?(word>>>3)&31:v.getUint32(24,true);let enabled=0;
    for(const a of vao.attributes.values())if(a.enabled){if(a.buffer!==null||a.view){recordGlError(b,0x502);return false;}enabled++;}
    if(enabled!==n){recordGlError(b,0x502);return false;}
    this.first=v.getInt32(compact?4:16,true);this.count=compact?(word>>>13)&65535:v.getInt32(20,true);this.draw.mode=compact?word&7:v.getUint32(12,true);this.draw.maxVertex=this.first+this.count-1;
    let p=compact?16:OWNED_INLINE_HEADER_BYTES,total=0,copied=0;
    for(let i=0;i<n;i++){
      const row=this.rows[i],index=v.getUint32(p,true),a=vao.attributes.get(index),size=v.getUint32(p+4,true),type=v.getUint32(p+8,true),normalized=!!v.getUint32(p+12,true),bytes=v.getUint32(p+16,true);
      if(!a?.enabled||a.buffer!==null||a.view||a.size!==size||a.type!==type||a.normalized!==normalized){recordGlError(b,0x502);return false;}
      row.index=index;row.size=size;row.type=type;row.normalized=normalized;row.element=size*width(type);row.bytes=bytes;row.source=p+ROW;row.scratch=copied;row.region=total;
      const pointer=this.pointers[i].call as ["vertexAttribPointer",number,number,number,boolean,number,number];
      pointer[1]=index;pointer[2]=size;pointer[3]=type===FIXED?FLOAT:type;pointer[4]=type===FIXED?false:normalized;pointer[5]=0;pointer[6]=total;
      const restore=this.restoreCalls[i+1] as typeof pointer;
      restore[1]=index;restore[2]=a.size;restore[3]=a.type===FIXED?FLOAT:a.type;restore[4]=a.type===FIXED?false:a.normalized;restore[5]=packedVertexLayout(a)?0:a.stride;restore[6]=0;
      total+=Math.ceil((this.first+this.count)*row.element/4)*4;copied+=Math.ceil(bytes/4)*4;p+=ROW+bytes;
    }
    if(copied>this.scratch.length){recordGlError(b,0x502);return false;}
    for(let i=0;i<n;i++){
      const row=this.rows[i];
      for(let j=0;j<row.bytes;j++)this.scratch[row.scratch+j]=v.getUint8(row.source+j);
      if(row.type===FIXED)for(let j=0;j<row.bytes;j+=4)this.scratchView.setFloat32(row.scratch+j,this.scratchView.getInt32(row.scratch+j,true)/65536,true);
    }
    this.n=n;this.total=total;this.copied=copied;this.proof=proof;
    for(let i=0;i<ATTRIBUTES;i++)this.inverse.prepared.groups[0][i+1].enabled=i<n;
    (this.restoreCalls[ATTRIBUTES+1] as ["bindBuffer",number,WebGLBuffer|null])[2]=b.shadow.arrayBuffer;
    try{return this.receiver.apply();}finally{this.proof=null;}
  }
  retire():boolean {
    this.phase="closed";
    if(this.retirement&&!retireNativeRetirement(this.retirement))return false;
    this.stream=null;(this.select.call as ["bindBuffer",number,WebGLBuffer|null])[2]=null;
    if(this.execution&&!this.execution.release())return false;this.execution=null;return true;
  }
}
