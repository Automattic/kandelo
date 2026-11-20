import {describe,it,expect} from 'vitest';
import {MemoryGroupPagePool} from '../src/memory-group-pool';
const PAGE=65536;
function fixture(initial=2,maximum=8,capacity=maximum) {
  const memory=new WebAssembly.Memory({initial,maximum,shared:true});
  return {memory,pool:MemoryGroupPagePool.initialize(memory,capacity)};
}
describe('shared physical page pool primitive',()=>{
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
});
