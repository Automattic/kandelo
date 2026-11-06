/** One synchronous borrowed command payload. Journal activation reserves the
 * scalar scratch cold: constructing DataViews per TLV after the guest has
 * accepted an exact command would introduce a new CPU-allocation failure.
 * Ordinary contexts keep their existing decoder and allocate no receiver. */
import {nativeGlFault} from "./native-recovery.js";
export class GlWirePayload implements DataView {
  readonly [Symbol.toStringTag]="DataView";
  private readonly scratch=new DataView(new ArrayBuffer(8));
  private readonly scalar=new Uint8Array(this.scratch.buffer);
  private bytes:Uint8Array|null=null;
  private offset=0;
  private length=0;
  private active=false;
  get buffer():ArrayBufferLike {return this.bytes?.buffer??this.scratch.buffer;}
  get byteOffset():number {return this.bytes?this.bytes.byteOffset+this.offset:0;}
  get byteLength():number{return this.length;}
  begin():void {if(this.active)nativeGlFault("A synchronous GL wire receiver reentered");this.active=true;}
  // Drop the exact guest backing even on decoder exceptions. A later walk
  // borrows its current view afresh after Wasm growth or registry retirement;
  // the reusable scalar receiver must never keep the previous address space.
  end():void {this.bytes=null;this.offset=this.length=0;this.active=false;}
  reset(bytes:Uint8Array,offset:number,length:number):this {this.bytes=bytes;this.offset=offset;this.length=length;return this;}
  private read(at:number,size:number):void {
    if(!this.bytes||!Number.isInteger(at)||at<0||at>this.length-size)throw new RangeError("GL payload read outside its exact record");
    for(let i=0;i<size;i++)this.scalar[i]=this.bytes[this.offset+at+i];
  }
  private write(at:number,size:number):void {
    if(!this.bytes||!Number.isInteger(at)||at<0||at>this.length-size)throw new RangeError("GL payload write outside its exact record");
    for(let i=0;i<size;i++)this.bytes[this.offset+at+i]=this.scalar[i];
  }
  getInt8(at:number):number {this.read(at,1);return this.scratch.getInt8(0);}
  setInt8(at:number,value:number):void {this.scratch.setInt8(0,value);this.write(at,1);}
  getUint8(at:number):number {this.read(at,1);return this.scratch.getUint8(0);}
  setUint8(at:number,value:number):void {this.scratch.setUint8(0,value);this.write(at,1);}
  getInt16(at:number,littleEndian?:boolean):number {this.read(at,2);return this.scratch.getInt16(0,littleEndian);}
  setInt16(at:number,value:number,littleEndian?:boolean):void {this.scratch.setInt16(0,value,littleEndian);this.write(at,2);}
  getUint16(at:number,littleEndian?:boolean):number {this.read(at,2);return this.scratch.getUint16(0,littleEndian);}
  setUint16(at:number,value:number,littleEndian?:boolean):void {this.scratch.setUint16(0,value,littleEndian);this.write(at,2);}
  getInt32(at:number,littleEndian?:boolean):number {this.read(at,4);return this.scratch.getInt32(0,littleEndian);}
  setInt32(at:number,value:number,littleEndian?:boolean):void {this.scratch.setInt32(0,value,littleEndian);this.write(at,4);}
  getUint32(at:number,littleEndian?:boolean):number {this.read(at,4);return this.scratch.getUint32(0,littleEndian);}
  setUint32(at:number,value:number,littleEndian?:boolean):void {this.scratch.setUint32(0,value,littleEndian);this.write(at,4);}
  getFloat16(at:number,littleEndian?:boolean):number {this.read(at,2);return this.scratch.getFloat16(0,littleEndian);}
  setFloat16(at:number,value:number,littleEndian?:boolean):void {this.scratch.setFloat16(0,value,littleEndian);this.write(at,2);}
  getFloat32(at:number,littleEndian?:boolean):number {this.read(at,4);return this.scratch.getFloat32(0,littleEndian);}
  setFloat32(at:number,value:number,littleEndian?:boolean):void {this.scratch.setFloat32(0,value,littleEndian);this.write(at,4);}
  getFloat64(at:number,littleEndian?:boolean):number {this.read(at,8);return this.scratch.getFloat64(0,littleEndian);}
  setFloat64(at:number,value:number,littleEndian?:boolean):void {this.scratch.setFloat64(0,value,littleEndian);this.write(at,8);}
  getBigInt64(at:number,littleEndian?:boolean):bigint {this.read(at,8);return this.scratch.getBigInt64(0,littleEndian);}
  setBigInt64(at:number,value:bigint,littleEndian?:boolean):void {this.scratch.setBigInt64(0,value,littleEndian);this.write(at,8);}
  getBigUint64(at:number,littleEndian?:boolean):bigint {this.read(at,8);return this.scratch.getBigUint64(0,littleEndian);}
  setBigUint64(at:number,value:bigint,littleEndian?:boolean):void {this.scratch.setBigUint64(0,value,littleEndian);this.write(at,8);}
}
