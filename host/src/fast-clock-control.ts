/** Private TS-05 component. Kernel issuance/invalidation must be integrated
 * before this can serve an ordinary guest. Not a timestamp cache or TTL. */
const load = Atomics.load;
const store = Atomics.store;
const add = Atomics.add;
const apply = Reflect.apply;
const freeze = Object.freeze;
const setPrototypeOf = Object.setPrototypeOf;
const arrayPush = Array.prototype.push;
const NativeArrayBuffer = ArrayBuffer;
const NativeDataView = DataView;
const NativeUint8Array = Uint8Array;
const states = new WeakMap<object, Int32Array>();
const weakGet = WeakMap.prototype.get;
const weakSet = WeakMap.prototype.set;
const dvLength = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")!.get!;
const dvSet = DataView.prototype.setUint8;
const dvI64 = DataView.prototype.setBigInt64;
const sabLength = Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")!.get!;
const MAX_EPOCH = 0x7fff_fffe;
const MAGIC = 0x4b434c31;
const EPOCH = 0, BUSY = 1, RETIRED = 2;
export const CLOCK_FALLBACK = 1;
declare const authorityBrand: unique symbol;
export type ClockEpochAuthority = { readonly [authorityBrand]: true };
function words(owner: ClockEpochAuthority): Int32Array {
  const value = apply(weakGet, states, [owner]) as Int32Array | undefined;
  if (!value) throw new Error("foreign clock epoch authority");
  return value;
}
export function createClockEpochAuthority(): ClockEpochAuthority {
  const owner = freeze(Object.create(null)) as ClockEpochAuthority;
  const control=new Int32Array(new SharedArrayBuffer(16));store(control,3,MAGIC);
  apply(weakSet, states, [owner, control]);
  return owner;
}
/** Independent bounded control bytes; never a kernel/guest memory view. */
export function shareClockEpoch(owner: ClockEpochAuthority): SharedArrayBuffer {
  return words(owner).buffer as SharedArrayBuffer;
}
/** Must run before every kernel entry/queued ingress or host mapping mutation. */
export function invalidateClockEpoch(owner: ClockEpochAuthority): void {
  const w = words(owner); store(w, BUSY, 1);
  if (load(w, RETIRED)) return;
  if (load(w, EPOCH) >= MAX_EPOCH) { store(w, RETIRED, 1); return; }
  add(w, EPOCH, 1);
}
/** Only the real entry gate may supply its quiescence result. */
export function refreshClockEpochBusy(owner: ClockEpochAuthority, busy: boolean): void {
  const w = words(owner);store(w, BUSY, load(w, RETIRED) || busy ? 1 : 0);
}
export function retireClockEpoch(owner: ClockEpochAuthority): void {
  const w=words(owner);store(w,BUSY,1);store(w,RETIRED,1);
}
export type ClockBinding = Readonly<{pid:number;tid:number;generation:number}>;
export type ClockCertificate = Readonly<ClockBinding & {
  version:1;epoch:number;pointer:number;clockId:number;format:0|1;
}>;
/** Call only after an actual authoritative range/signal check, using the epoch
 * captured AT that check. A late result must never acquire a newer epoch. */
export function captureValidatedClockCertificate(
  owner: ClockEpochAuthority, checkedEpoch: number, binding: ClockBinding,
  pointer: number, clockId: number, format: 0|1,
): ClockCertificate | undefined {
  const w=words(owner);
  if(load(w,RETIRED)||checkedEpoch<=0||load(w,EPOCH)!==checkedEpoch) return;
  if(canonicalClockId(clockId)===undefined||(format!==0&&format!==1))return;
  if(!Number.isSafeInteger(pointer)||pointer<0||pointer>0xfffffff0) return;
  for(const v of [binding.pid,binding.tid,binding.generation])
    if(!Number.isSafeInteger(v)||v<=0||v>0x7fffffff)return;
  return freeze({version:1,epoch:checkedEpoch,pointer,clockId:clockId|0,format,
    pid:binding.pid,tid:binding.tid,generation:binding.generation});
}
export function clockEpochValue(owner: ClockEpochAuthority): number {
  return load(words(owner),EPOCH);
}
export function canonicalClockId(id:number): number | undefined {
  if(!Number.isInteger(id)||id< -0x80000000||id>0x7fffffff)return;
  if(id===5)return 0;if(id===6)return 1;
  if(id===0||id===1||id===2||id===3||id===7)return id;
  if(id<0&&(id&7)===2)return 2;
}
export type ClockReading = {sec:bigint;nsec:bigint};
export type ClockSampler = (canonicalId:number)=>ClockReading;
/** prepareOutput runs before the final epoch check. It must return freshly
 * preflighted native views covering exactly16bytes, or undefined for fallback.
 * Physical views exist on this synchronous stack only, after clock sampling.
 * No producer can certify itself: ordinary kernel integration is still needed.
 */
export function createFastClockReader(options: {
  epoch: SharedArrayBuffer; binding:ClockBinding;
  sample:ClockSampler | undefined;
  certificate:()=>ClockCertificate|undefined;
  prepareOutput:(pointer:number,bytes:number)=>DataView[]|undefined;
}): (pointer:number,clockId:number,format:0|1)=>number {
  if(apply(sabLength,options.epoch,[])!==16)throw new Error("clock epoch version/size mismatch");
  const w=new Int32Array(options.epoch);
  if(load(w,3)!==MAGIC)throw new Error("clock epoch version/magic mismatch");
  const binding=freeze({...options.binding});
  const sample=options.sample,certificate=options.certificate,prepare=options.prepareOutput;
  return (pointer,clockId,format)=>{
    if(!sample||load(w,RETIRED)||load(w,BUSY))return CLOCK_FALLBACK;
    const epoch=load(w,EPOCH),cert=certificate(),id=canonicalClockId(clockId);
    if(id===undefined||!cert||cert.version!==1||cert.epoch!==epoch
      ||cert.pid!==binding.pid||cert.tid!==binding.tid||cert.generation!==binding.generation
      ||cert.pointer!==pointer||cert.clockId!==clockId||cert.format!==format
      ||(format!==0&&format!==1)||(format===1&&id!==0))return CLOCK_FALLBACK;
    const reading=sample(id);
    if(typeof reading.sec!=='bigint'||typeof reading.nsec!=='bigint'
      ||reading.sec<0n||reading.sec>0x7fff_ffff_ffff_ffffn
      ||reading.nsec<0n||reading.nsec>=1_000_000_000n)return CLOCK_FALLBACK;
    const raw=prepare(pointer,16);if(!raw)return CLOCK_FALLBACK;
    // Read all potentially effectful preflight properties before validation.
    // This list never escapes and has no inherited element accessors. Keep
    // every potentially effectful traversal before the final epoch check.
    const views=apply(setPrototypeOf,undefined,[[],null]) as {view:DataView;length:number}[];let bytes=0;
    for(const view of raw){
      const length=apply(dvLength,view,[]) as number;
      if(!length||length>16||bytes+length>16)return CLOCK_FALLBACK;
      apply(arrayPush,views,[{view,length}]);bytes+=length;
    }
    if(bytes!==16)return CLOCK_FALLBACK;
    const stagingBytes=new NativeArrayBuffer(16),staging=new NativeDataView(stagingBytes);
    apply(dvI64,staging,[0,reading.sec,true]);
    apply(dvI64,staging,[8,format===0?reading.nsec:reading.nsec/1000n,true]);
    const data=new NativeUint8Array(stagingBytes);
    if(load(w,RETIRED)||load(w,BUSY)||load(w,EPOCH)!==epoch)return CLOCK_FALLBACK;
    // Native intrinsic writes only: no callbacks/getters after this check.
    let at=0;
    for(let slot=0;slot<views.length;slot++) {
      const item=views[slot];
      for(let i=0;i<item.length;i++)apply(dvSet,item.view,[i,data[at++]]);
    }
    return 0;
  };
}
