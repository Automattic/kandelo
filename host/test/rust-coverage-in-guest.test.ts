import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeKernelHost } from '../src/node-kernel-host';
import { createRustCargoImage, resolveRustCargoArtifacts } from './fixtures/rust-cargo';
import { rustCompilerEnv } from './fixtures/rust-compiler';
import { exerciseRustCoverage } from './fixtures/rust-coverage';
import { rustCoverageFiles } from './fixtures/rust-coverage-project';
const paths=resolveRustCargoArtifacts();
const available=paths.every(path=>path!==null);
if(!available&&process.env.KANDELO_REQUIRE_GUEST_CARGO==='1')throw new Error('Build kernel and kandelo-rust-sdk before Rust coverage acceptance');
describe.skipIf(!available)('Rust coverage inside Kandelo',()=>{
 it('builds with ordinary Cargo and reports real branch, child, thread and libtest profiles',async()=>{
  const [kernel,bundle]=paths.map(path=>readFileSync(path!));
  const {image,assets}=await createRustCargoImage(bundle!,rustCoverageFiles);
  const work=mkdtempSync(join(tmpdir(),'kandelo-rust-coverage-'));
  const host=new NodeKernelHost({rootfsImage:image,rootfsLazyAssets:assets,maxWorkers:8,experimentalResizablePersistencePath:join(work,'journal')});
  try{
   await host.init(Uint8Array.from(kernel!).buffer);
   const result=await exerciseRustCoverage(host,rustCompilerEnv);
   const output=process.env.KANDELO_TEST_REPORT_DIR;
   if(output){mkdirSync(output,{recursive:true});writeFileSync(join(output,`rust-coverage-node-${randomUUID()}.json`),JSON.stringify(result,null,2)+'\n');}
   expect(result.profileFiles.subprocess).toHaveLength(2);
  }finally{await host.destroy();rmSync(work,{recursive:true,force:true});}
 },1800000);
});
