import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { readTrustedDesktopProgram } from '../../images/vfs/scripts/trusted-desktop-program';
const digest = (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest());
const program = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
function fixture() {
 const compressed = zipSync({ 'libexec/freeciv/client.wasm': program, 'share/data': new Uint8Array(128).fill(42) });
 const file = { path:'/usr/libexec/freeciv/client.wasm',ino:1n,size:program.length,archiveId:7,sourcePath:'libexec/freeciv/client.wasm',descriptor:new Uint8Array(),uri:'',digest:digest(program) };
 const archive = { archiveId:7,bytes:compressed.length,descriptor:new Uint8Array(),uri:'programs/freeciv.zip',digest:digest(compressed) };
 return { compressed,file,archive };
}
describe('trusted desktop executable sources', () => {
 it('reads the exact declared archive member without substituting assets or basenames', () => {
  const {compressed,file,archive}=fixture();const requested:string[]=[];
  expect(readTrustedDesktopProgram(file,[archive],uri=>{requested.push(uri);return compressed;})).toEqual(program);
  expect(requested).toEqual([archive.uri]);
  expect(()=>readTrustedDesktopProgram({...file,sourcePath:'client.wasm'},[archive],()=>compressed)).toThrow(/absent/);
 });
 it('refuses missing archives, absent integrity and archive/member mismatches', () => {
  const {compressed,file,archive}=fixture();
  expect(()=>readTrustedDesktopProgram(file,[],()=>compressed)).toThrow(/lacks/);
  expect(()=>readTrustedDesktopProgram(file,[{...archive,digest:new Uint8Array(32)}],()=>compressed)).toThrow(/lacks/);
  for(const bad of [{...archive,bytes:archive.bytes+1},{...archive,digest:digest(program)}])
   expect(()=>readTrustedDesktopProgram(file,[bad],()=>compressed)).toThrow(/archive differs/);
  expect(()=>readTrustedDesktopProgram({...file,size:program.length+1},[archive],()=>compressed)).toThrow(/member differs/);
  expect(()=>readTrustedDesktopProgram({...file,digest:digest(compressed)},[archive],()=>compressed)).toThrow(/executable differs/);
 });
 it('retains standalone size and optional digest validation', () => {
  const {file}=fixture(),standalone={...file,archiveId:0,uri:'programs/exact.wasm'};
  expect(readTrustedDesktopProgram(standalone,[],uri=>{expect(uri).toBe(standalone.uri);return program;})).toEqual(program);
  expect(()=>readTrustedDesktopProgram(standalone,[],()=>new Uint8Array(3))).toThrow(/differs/);
  expect(()=>readTrustedDesktopProgram({...standalone,digest:new Uint8Array(32).fill(9)},[],()=>program)).toThrow(/differs/);
 });
});
