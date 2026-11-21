import {describe,it,expect,vi} from 'vitest';
import {MemoryGroupPagePool} from '../src/memory-group-pool';
import * as G from '../src/generated/program-extensions';
const PAGE=65536;
function fixture(initial=2,maximum=8,capacity=maximum) {
  const memory=new WebAssembly.Memory({initial,maximum,shared:true});
  return {memory,pool:MemoryGroupPagePool.initialize(memory,capacity)};
}
describe('shared physical page pool primitive',()=>{
 it('refuses diagnostic lock contention without waiting, then reports fresh allocation',()=>{
  const {pool,memory}=fixture(),lock=new Int32Array(memory.buffer,G.MEMORY_GROUP_CONTROL,1);
  const before=pool.trySnapshot();
  const wait=vi.spyOn(Atomics,'wait').mockImplementation(()=>{throw Error('Inspection must not wait');});
  Atomics.store(lock,0,1);
  try {expect(pool.trySnapshot()).toBe('busy');expect(Atomics.load(lock,0)).toBe(1);}
  finally {Atomics.store(lock,0,0);wait.mockRestore();}
  expect(pool.trySnapshot()).toEqual(before);
  pool.allocateContiguous(3);
  expect(pool.trySnapshot()).toEqual({maximumPages:8,allocatedPages:4,highWaterPages:4,physicalExtentPages:4});
  expect(before).toEqual({maximumPages:8,allocatedPages:1,highWaterPages:1,physicalExtentPages:2});
 });
 it('reserves image controls and fragmented payload atomically and zeroes every reused page',()=>{
  const {pool,memory}=fixture(1,16);pool.allocateContiguous(15);
  new Uint8Array(memory.buffer,PAGE,15*PAGE).fill(0xad);
  pool.releaseRetiredPages([1,2,4,6,8]);
  const payload=new Uint32Array([99,99]),result=pool.tryAllocateImage(1,2,payload);
  expect(result).toEqual({controls:{first:4,pages:1},scratch:{first:1,pages:2}});
  expect([...payload]).toEqual([6,8]);expect(pool.snapshot().allocatedPages).toBe(16);
  for(const page of [1,2,4,6,8])expect(new Uint8Array(memory.buffer,page*PAGE,PAGE).every(v=>v===0)).toBe(true);
  for(const page of [3,5,7,9])expect(new Uint8Array(memory.buffer,page*PAGE,PAGE).every(v=>v===0xad)).toBe(true);
 });
 it('leaves image output and ownership intact on busy, exhaustion and real growth refusal',()=>{
  const {pool,memory}=fixture(1,16),payload=new Uint32Array([99,99]);
  const lock=new Int32Array(memory.buffer,G.MEMORY_GROUP_CONTROL,1);Atomics.store(lock,0,1);
  try {expect(pool.tryAllocateImage(1,2,payload)).toBe('busy');expect([...payload]).toEqual([99,99]);}
  finally {Atomics.store(lock,0,0);}
  expect(pool.snapshot().allocatedPages).toBe(1);
  pool.allocateContiguous(13);const before=pool.snapshot();
  expect(pool.tryAllocateImage(1,2,payload)).toBe('exhausted');
  expect(pool.snapshot()).toEqual(before);expect([...payload]).toEqual([99,99]);
  const limited=fixture(1,2,16),limitedBefore=limited.pool.snapshot();
  expect(limited.pool.tryAllocateImage(1,2,payload)).toBe('exhausted');
  expect(limited.pool.snapshot()).toEqual(limitedBefore);expect([...payload]).toEqual([99,99]);
 });
 it('supports empty image payloads and multi-page controls without overlapping scratch',()=>{
  const {pool}=fixture(1,16);
  expect(pool.tryAllocateImage(3,2,new Uint32Array())).toEqual({controls:{first:1,pages:3},scratch:{first:4,pages:2}});
  expect(pool.snapshot()).toMatchObject({allocatedPages:6,highWaterPages:6,physicalExtentPages:6});
 });
 it('rejects invalid image extents and shared output before taking the pool lock',()=>{
  const {pool}=fixture(),before=pool.snapshot();
  for(const [controls,scratch] of [[0,2],[1,0],[-1,2],[1,1.5],[NaN,2],[1,Infinity]]) {
   expect(()=>pool.tryAllocateImage(controls,scratch,new Uint32Array())).toThrow();
  }
  expect(()=>pool.tryAllocateImage(1,2,new Uint32Array(new SharedArrayBuffer(4)))).toThrow();
  expect(pool.snapshot()).toEqual(before);
 });
 it('keeps groups independent and reserves page zero',()=>{
  const a=fixture(),b=fixture();const first=a.pool.allocateContiguous(1)!;
  expect(first).toEqual({first:1,pages:1});expect(b.pool.snapshot().allocatedPages).toBe(1);
  new Uint8Array(a.memory.buffer,PAGE,PAGE).fill(255);
  expect(new Uint8Array(b.memory.buffer,PAGE,PAGE).every(v=>v===0)).toBe(true);
 });
 it('zeroes retired storage before reusing it without growing the extent',()=>{
  const {memory,pool}=fixture();const a=pool.allocateContiguous(1)!;
  new Uint8Array(memory.buffer,a.first*PAGE,PAGE).fill(0xea);pool.releaseRetiredPages([a.first]);
  expect(pool.allocateContiguous(1)).toEqual(a);
  expect(new Uint8Array(memory.buffer,a.first*PAGE,PAGE).every(v=>v===0)).toBe(true);
  expect(pool.snapshot()).toEqual({maximumPages:8,allocatedPages:2,highWaterPages:2,physicalExtentPages:2});
 });
 it('leaves live allocations intact when any retirement is invalid',()=>{
  const {pool}=fixture();const a=pool.allocateContiguous(2)!;const before=pool.snapshot();
  for(const pages of [[a.first,a.first],[a.first,7],[0],[NaN],[1.5]]) {
   expect(()=>pool.releaseRetiredPages(pages)).toThrow();expect(pool.snapshot()).toEqual(before);
  }
  expect(pool.allocateContiguous(1)?.first).toBe(3);
 });
 it('refuses a real storage grow failure before publishing allocation bits',()=>{
  const {pool}=fixture(2,2,8);const before=pool.snapshot();
  expect(pool.allocateContiguous(4)).toBeUndefined();expect(pool.snapshot()).toEqual(before);
  expect(pool.allocateContiguous(1)).toEqual({first:1,pages:1});
 });
 it('grows with fresh views and refuses exhaustion without changing state',()=>{
  const {pool,memory}=fixture();expect(pool.allocateContiguous(7)).toEqual({first:1,pages:7});
  expect(memory.buffer.byteLength).toBe(8*PAGE);const before=pool.snapshot();
  expect(pool.allocateContiguous(1)).toBeUndefined();expect(pool.snapshot()).toEqual(before);
 });
 it('rejects metadata reset, mismatched attachments and invalid capacities',()=>{
  const {pool,memory}=fixture();pool.allocateContiguous(1);
  expect(()=>MemoryGroupPagePool.initialize(memory,8)).toThrow();
  expect(()=>MemoryGroupPagePool.attach(memory,7)).toThrow();
  expect(MemoryGroupPagePool.attach(memory,8).snapshot()).toEqual(pool.snapshot());
  for(const pages of [0,-1,1.5,NaN,Infinity,16385])expect(()=>MemoryGroupPagePool.initialize(memory,pages)).toThrow();
 });
 it('allocates fragmented pages in order and zeroes old payload before publication',()=>{
  const {pool,memory}=fixture();pool.allocateContiguous(7);
  new Uint8Array(memory.buffer,PAGE,7*PAGE).fill(0xa5);
  pool.releaseRetiredPages([1,3,5]);
  const selected=new Uint32Array([99,99,99]);
  expect(pool.tryAllocatePages(selected)).toBe('allocated');expect([...selected]).toEqual([1,3,5]);
  for(const page of selected)expect(new Uint8Array(memory.buffer,page*PAGE,PAGE).every(v=>v===0)).toBe(true);
  for(const page of [2,4,6,7])expect(new Uint8Array(memory.buffer,page*PAGE,PAGE).every(v=>v===0xa5)).toBe(true);
  expect(pool.snapshot()).toEqual({maximumPages:8,allocatedPages:8,highWaterPages:8,physicalExtentPages:8});
 });
 it('refuses a busy pool immediately and preserves unpublished custody until retry',()=>{
  const {pool,memory}=fixture();const selected=new Uint32Array([99]);
  const lock=new Int32Array(memory.buffer,G.MEMORY_GROUP_CONTROL,1);
  Atomics.store(lock,0,1);
  try {expect(pool.tryAllocatePages(selected)).toBe('busy');expect([...selected]).toEqual([99]);}
  finally {Atomics.store(lock,0,0);}
  expect(pool.tryAllocatePages(selected)).toBe('allocated');
  const before=pool.snapshot();Atomics.store(lock,0,1);
  try {expect(pool.tryReleaseUnpublishedPages(selected)).toBe('busy');}
  finally {Atomics.store(lock,0,0);}
  expect(pool.snapshot()).toEqual(before);
  expect(pool.tryReleaseUnpublishedPages(selected)).toBe('released');
  expect(pool.snapshot().allocatedPages).toBe(1);
 });
 it('keeps output and allocation unchanged on exhaustion and actual grow refusal',()=>{
  for(const state of [fixture(),fixture(2,2,8)]) {
   const {pool}=state;
   if(state.memory.buffer.byteLength/PAGE!==2)throw Error('Invalid fixture');
   // The first pool exhausts its bitmap, the second its real Memory maximum.
   if(pool.allocateContiguous(7)) {
    const selected=new Uint32Array([99]);const before=pool.snapshot();
    expect(pool.tryAllocatePages(selected)).toBe('exhausted');
    expect([...selected]).toEqual([99]);expect(pool.snapshot()).toEqual(before);
   } else {
    const selected=new Uint32Array([99,99]);const before=pool.snapshot();
    expect(pool.tryAllocatePages(selected)).toBe('exhausted');
    expect([...selected]).toEqual([99,99]);expect(pool.snapshot()).toEqual(before);
   }
  }
 });
 it('grows once to the last selected page and refreshes bounded views',()=>{
  const {pool,memory}=fixture(1);const old=memory.buffer;const selected=new Uint32Array(4);
  expect(pool.tryAllocatePages(selected)).toBe('allocated');expect([...selected]).toEqual([1,2,3,4]);
  expect(old.byteLength).toBe(PAGE);expect(memory.buffer.byteLength).toBe(5*PAGE);
  expect(pool.snapshot()).toEqual({maximumPages:8,allocatedPages:5,highWaterPages:5,physicalExtentPages:5});
 });
 it('preflights every rollback page before releasing any allocation',()=>{
  const {pool}=fixture();const selected=new Uint32Array(3);pool.tryAllocatePages(selected);
  const before=pool.snapshot();
  for(const invalid of [[1,1],[2,1],[1,7],[0],[8]]) {
   expect(()=>pool.tryReleaseUnpublishedPages(new Uint32Array(invalid))).toThrow();
   expect(pool.snapshot()).toEqual(before);
  }
  expect(pool.tryReleaseUnpublishedPages(selected)).toBe('released');
  expect(()=>pool.tryReleaseUnpublishedPages(selected)).toThrow();expect(pool.snapshot().allocatedPages).toBe(1);
 });
 it('refuses shared page lists and invalid counts before taking the lock',()=>{
  const {pool,memory}=fixture();const before=pool.snapshot();
  const shared=new Uint32Array(new SharedArrayBuffer(4));shared[0]=1;
  for(const invalid of [shared,new Uint32Array(0),new Uint32Array(8)])expect(()=>pool.tryAllocatePages(invalid)).toThrow();
  expect(()=>pool.tryReleaseUnpublishedPages(shared)).toThrow();expect(pool.snapshot()).toEqual(before);
  expect(Atomics.load(new Int32Array(memory.buffer,G.MEMORY_GROUP_CONTROL,1),0)).toBe(0);
 });
});
