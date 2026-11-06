/** Cold execution workspace for the bounded owned-buffer wire format. */
import type {GlBinding} from "./registry.js";
import {issueGlesDraw,sequentialVertices,type GlesDraw} from "./draw-state.js";
import {PreparedNativeChanges,prepareNativeCall,prepareNativeInverse,checkedPreparedNativeCall,
  type NativeCall,type PreparedNativeCall,type PreparedNativeInverse} from "./native-recovery.js";

const ARRAY=0x8892;
export class BufferSnapshotDraw {
  private readonly applyCalls:PreparedNativeCall[];
  private readonly restoreCalls:NativeCall[];
  private readonly receiver:PreparedNativeChanges;
  private readonly inverse:PreparedNativeInverse;
  private view:GlBinding;
  private first=0;
  private count=0;
  private readonly draw:GlesDraw;
  readonly run=():boolean=>this.receiver.apply();
  constructor(private readonly binding:GlBinding){
    const b=binding,gl=b.gl!;this.view=b;
    const apply:NativeCall[]=[],restore:NativeCall[]=[];
    for(let i=0;i<16;i++){
      apply.push(["bindBuffer",ARRAY,null],["vertexAttribPointer",i,4,0x1406,false,0,0]);
      restore.push(["bindBuffer",ARRAY,null],["vertexAttribPointer",i,4,0x1406,false,0,0]);
    }
    restore.push(["bindBuffer",ARRAY,null]);this.restoreCalls=restore;
    this.applyCalls=apply.map(call=>prepareNativeCall(gl,call));
    const inverse=prepareNativeInverse(b,restore),empty=prepareNativeInverse(b);
    if(!inverse||!empty)throw new Error("Unable to reserve owned draw inverse");this.inverse=inverse;
    this.draw={mode:0,observed:false,maxVertex:0,issue:()=>gl.drawArrays(this.draw.mode,this.first,this.count),
      vertices:()=>sequentialVertices(this.first,this.count)};
    const receiver=PreparedNativeChanges.reserve(b,[{apply:()=>{
      for(const call of this.applyCalls)if(!checkedPreparedNativeCall(b,call))return false;
      return true;
    },restore:inverse},{apply:()=>issueGlesDraw(this.view,this.draw),restore:empty}],{finalizer:inverse});
    if(!receiver)throw new Error("Unable to reserve owned draw receiver");this.receiver=receiver;
  }
  /** No warmed command may allocate its recovery after C has answered its
   * error locally. These fixed rows hold only this synchronous borrow; the
   * complete wire record is validated before run can mutate the renderer. */
  begin(view:GlBinding,mode:number,first:number,count:number):void {
    this.view=view;this.draw.mode=mode;this.first=first;this.count=count;this.draw.maxVertex=first+count-1;
    for(const call of this.applyCalls)call.enabled=false;
    const inverse=this.restoreCalls;
    // Disabled rows restore their already-selected attribute back to itself;
    // skipping them also avoids touching attributes absent from this draw.
    for(let i=0;i<32;i++)this.inverse.prepared.groups[0][i].enabled=false;
    (inverse[32] as ["bindBuffer",number,WebGLBuffer|null])[2]=this.binding.shadow.arrayBuffer;
  }
  row(row:number,index:number,source:WebGLBuffer,original:WebGLBuffer,size:number,type:number,normalized:boolean,stride:number,offset:number):void {
    const at=row*2,apply=this.applyCalls,restore=this.restoreCalls;
    (apply[at].call as ["bindBuffer",number,WebGLBuffer|null])[2]=source;
    const a=apply[at+1].call as ["vertexAttribPointer",number,number,number,boolean,number,number];
    a[1]=index;a[2]=size;a[3]=type;a[4]=normalized;a[5]=stride;a[6]=offset;
    (restore[at] as ["bindBuffer",number,WebGLBuffer|null])[2]=original;
    const r=restore[at+1] as typeof a;
    r[1]=index;r[2]=size;r[3]=type;r[4]=normalized;r[5]=stride;r[6]=offset;
    apply[at].enabled=apply[at+1].enabled=true;
    this.inverse.prepared.groups[0][at].enabled=this.inverse.prepared.groups[0][at+1].enabled=true;
  }
}
