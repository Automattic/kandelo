/** CPU upload storage admitted before the guest can predict a setter's error.
 * WebGL copies uniform inputs synchronously. Reusing one bounded private bank
 * therefore borrows no guest memory and needs no per-setter view allocation. */
import {rethrowNativeGlFault} from "./native-recovery.js";

// The inline TLV payload is at most65535 bytes, including its header. Larger
// uploads keep the existing observed, separately staged transport.
export const UNIFORM_CPU_COMPONENTS=16384;
export class GlUniformCpuPreparation {
  readonly floats:Float32Array<ArrayBuffer>;
  readonly integers:Int32Array<ArrayBuffer>;
  private constructor(){
    this.floats=new Float32Array(UNIFORM_CPU_COMPONENTS);
    this.integers=new Int32Array(UNIFORM_CPU_COMPONENTS);
  }
  static reserve():GlUniformCpuPreparation|null {
    try{return new GlUniformCpuPreparation();}
    catch(error){rethrowNativeGlFault(error);return null;}
  }
  /** Read exact little-endian values, including unaligned or shared-backed
   * input. Creating a subarray here would reintroduce the CPU failure after
   * local NoError; WebGL2's explicit source length selects the live prefix. */
  readFloats(v:DataView,offset:number,count:number):Float32Array<ArrayBuffer> {
    if(count>this.floats.length||count<0||offset<0||offset+count*4>v.byteLength)throw new RangeError("Uniform CPU float span exceeds admitted storage");
    for(let i=0;i<count;i++)this.floats[i]=v.getFloat32(offset+i*4,true);
    return this.floats;
  }
  readIntegers(v:DataView,offset:number,count:number):Int32Array<ArrayBuffer> {
    if(count>this.integers.length||count<0||offset<0||offset+count*4>v.byteLength)throw new RangeError("Uniform CPU integer span exceeds admitted storage");
    for(let i=0;i<count;i++)this.integers[i]=v.getInt32(offset+i*4,true);
    return this.integers;
  }
}
