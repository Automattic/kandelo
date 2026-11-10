import {setPreparedUniformResetRecovery} from "./native-batch.js";
/** Uniform values retained only while an owned-draw proof needs private
 * executables. Ordinary programs acquire no mirror or per-write copy. */
import type {GlBinding} from "./registry.js";
import type {GlUniformLayout,GlUniformEntry} from "./uniform-layout.js";
import {checkedGlCall} from "./program-objects.js";
import {rethrowNativeGlFault,nativeGlFault} from "./native-recovery.js";
import * as O from "./ops.js";

export type PreparedUniformValue={entry:GlUniformEntry;components:number;integer:boolean;boolean:boolean;
  values:Float32Array<ArrayBuffer>|Int32Array<ArrayBuffer>;locations:readonly WebGLUniformLocation[]};
const COMPONENTS=new Map([[0x1406,1],[0x8b50,2],[0x8b51,3],[0x8b52,4],
  [0x1404,1],[0x8b53,2],[0x8b54,3],[0x8b55,4],[0x8b56,1],[0x8b57,2],[0x8b58,3],[0x8b59,4],
  [0x8b5a,4],[0x8b5b,9],[0x8b5c,16],[0x8b5e,1],[0x8b60,1],[0x8dc1,1]]);
function integerType(type:number):boolean{return type===0x1404||type>=0x8b53&&type<=0x8b59||type===0x8b5e||type===0x8b60||type===0x8dc1;}
const liveByRenderer=new WeakMap<WebGL2RenderingContext,Set<PreparedUniformValues>>();
let liveMirrors=0;
export class PreparedUniformValues {
  private references=1;
  generation=0;
  private readonly slots:PreparedUniformValue[]=[];
  private constructor(readonly layout:GlUniformLayout,readonly rows:PreparedUniformValue[],private readonly gl:WebGL2RenderingContext) {
    for(const row of rows)for(let i=0;i<row.entry.size;i++)this.slots[row.entry.location+i]=row;
  }
  static acquire(b:GlBinding,layout:GlUniformLayout):PreparedUniformValues|null {
    if(layout.ownedValues){layout.ownedValues.references++;return layout.ownedValues;}
    try {
      let total=0;
      for(const entry of layout.entries){const components=COMPONENTS.get(entry.type);if(!components||(total+=entry.size*components)>16384)return null;}
      const rows:PreparedUniformValue[]=[];
      for(const entry of layout.entries){
        const components=COMPONENTS.get(entry.type)!,integer=integerType(entry.type),boolean=entry.type>=0x8b56&&entry.type<=0x8b59;
        const values=integer?new Int32Array(entry.size*components):new Float32Array(entry.size*components),locations:WebGLUniformLocation[]=[];
        for(let i=0;i<entry.size;i++){
          const location=layout.native(b,entry.location+i);if(location===false)return null;if(!location)return null;locations.push(location);
          let value:unknown;
          if(!checkedGlCall(b,()=>{value=b.gl!.getUniform(layout.executable,location);} ))return null;
          if((typeof value!=="number"&&typeof value!=="boolean")&&(!value||typeof (value as ArrayLike<number>).length!=="number"||(value as ArrayLike<number>).length<components))return null;
          for(let j=0;j<components;j++){
            const number=typeof value==="number"||typeof value==="boolean"?Number(value):Number((value as ArrayLike<number>)?.[j]??0);
            values[i*components+j]=boolean?(number!==0?1:0):number;
          }
        }
        rows.push({entry,components,integer,boolean,values,locations});
      }
      const mirror=new PreparedUniformValues(layout,rows,b.gl!);
      let live=liveByRenderer.get(b.gl!);if(!live){live=new Set();liveByRenderer.set(b.gl!,live);}
      live.add(mirror);liveMirrors++;setPreparedUniformResetRecovery(reconcilePreparedUniformValues);
      layout.ownedValues=mirror;return mirror;
    }catch(error){rethrowNativeGlFault(error);return null;}
  }
  release():void {
    if(--this.references===0){
      if(this.layout.ownedValues===this)this.layout.ownedValues=null;
      const live=liveByRenderer.get(this.gl);if(live?.delete(this)){liveMirrors--;if(!live.size)liveByRenderer.delete(this.gl);}
      if(!liveMirrors)setPreparedUniformResetRecovery(null);
    }
  }
  /** Exceptional native failure may reject a setter after optimistic host
   * validation. Reconcile the shared executable before a healthy peer can
   * upload this mirror into its private variant. All locations and CPU value
   * banks already exist; no normal frame pays for native reflection. */
  reconcileAfterReset():void {
    const gl=this.gl;
    for(const row of this.rows)for(let i=0;i<row.entry.size;i++){
      const value:unknown=gl.getUniform(this.layout.executable,row.locations[i]);
      const error=gl.getError();if(error)nativeGlFault(`Prepared shared uniform recovery observed native error 0x${error.toString(16)}`);
      if((typeof value!=="number"&&typeof value!=="boolean")&&(!value||typeof (value as ArrayLike<number>).length!=="number"||(value as ArrayLike<number>).length<row.components))
        nativeGlFault("Prepared shared uniform recovery returned no complete native value");
      for(let j=0;j<row.components;j++){
        const number=typeof value==="number"||typeof value==="boolean"?Number(value):Number((value as ArrayLike<number>)?.[j]??0);
        row.values[i*row.components+j]=row.boolean?(number!==0?1:0):number;
      }
    }
    this.generation=this.generation>=Number.MAX_SAFE_INTEGER?-1:this.generation<0?-1:this.generation+1;
  }
  sampler(location:number):number{return this.slots[location]?.values[location-this.slots[location].entry.location]??0;}
  /** Original setters already checked their complete signature and accepted
   * array prefix. Copy just that prefix; no typed view or receipt is created
   * after C's local acceptance. Peers update this same executable's cells. */
  write(op:number,v:DataView,p:number,count:number):void {
    const location=v.getInt32(p,true),row=this.slots[location];if(!row||count===0)return;
    const scalar=op<=O.OP_UNIFORM4F,matrix=op===O.OP_UNIFORM_MATRIX2FV||op===O.OP_UNIFORM_MATRIX3FV||op===O.OP_UNIFORM_MATRIX4FV;
    const integer=op===O.OP_UNIFORM1I||op>=O.OP_UNIFORM1IV&&op<=O.OP_UNIFORM4IV;
    const source=p+(scalar?4:matrix?12:8),target=(location-row.entry.location)*row.components;
    for(let i=0;i<count*row.components;i++){
      const value=integer?v.getInt32(source+i*4,true):v.getFloat32(source+i*4,true);
      row.values[target+i]=row.boolean?(value!==0?1:0):value;
    }
    this.generation=this.generation>=Number.MAX_SAFE_INTEGER?-1:this.generation<0?-1:this.generation+1;
  }
}


function reconcilePreparedUniformValues(gl:WebGL2RenderingContext):void {
  try{for(const mirror of liveByRenderer.get(gl)??[])mirror.reconcileAfterReset();}
  catch(error){rethrowNativeGlFault(error);nativeGlFault("Could not recover exact shared uniform values after native context reset",error);}
}
