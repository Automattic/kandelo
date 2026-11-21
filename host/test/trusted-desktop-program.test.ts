import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { readTrustedDesktopProgram } from '../../images/vfs/scripts/trusted-desktop-program';
import { sharedDesktopPrograms, SHARED_DESKTOP_LOGIN_PROGRAMS, SHARED_DESKTOP_PROGRAMS } from '../../images/vfs/scripts/shared-desktop-contract';
import { trustedDesktopPreview } from '../../apps/browser-demos/vite/trusted-desktop-preview';
const digest = (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest());
const hash = (bytes: Uint8Array) => Buffer.from(digest(bytes)).toString('hex');
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
describe('explicit trusted graphical-session closure', () => {
 it('retains Sway defaults and prepares Cage and both Freeciv executables explicitly', () => {
  expect(sharedDesktopPrograms('sway',false)).toEqual(SHARED_DESKTOP_PROGRAMS);
  const cage=sharedDesktopPrograms('cage',true);
  expect(cage).toContain('/usr/bin/cage');expect(cage).toContain('/usr/bin/foot');
  expect(cage).toContain('/usr/libexec/freeciv/client.wasm');expect(cage).toContain('/usr/libexec/freeciv/server.wasm');
  expect(cage).not.toContain('/usr/bin/sway');
  expect(()=>sharedDesktopPrograms('unknown' as never,false)).toThrow();
  expect(()=>sharedDesktopPrograms('cage','yes' as never)).toThrow();
 });
 it('binds the embedded image/report and refuses a missing graphical participant', () => {
  const dir=mkdtempSync(join(tmpdir(),'kandelo-trusted-closure-'));
  try {
   // Fake bytes test the embedder policy only; this is not a Wasm/image or
   // runtime acceptance fixture. SDK preparation separately validates those.
   const path=join(dir,'image.vfs.zst');writeFileSync(path,program);
   const report={inputSha256:hash(program),desktop:{profile:'cage',freeciv:true},output:{sha256:hash(program),bytes:program.length},programs:[...sharedDesktopPrograms('cage',true),...SHARED_DESKTOP_LOGIN_PROGRAMS].map(requested=>({requested}))};
   const save=()=>writeFileSync(path+'.memory-group.json',JSON.stringify(report));save();
   expect(trustedDesktopPreview('/',path)?.name).toBe('kandelo-trusted-desktop-preview');
   report.programs=report.programs.filter(p=>p.requested!=='/usr/libexec/freeciv/server.wasm');save();
   expect(()=>trustedDesktopPreview('/',path)).toThrow(/missing participant/);
   report.output.sha256='0'.repeat(64);save();expect(()=>trustedDesktopPreview('/',path)).toThrow(/differs/);
  } finally {rmSync(dir,{recursive:true,force:true});}
 });
});
