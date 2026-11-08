import{existsSync,readFileSync}from'node:fs';
import{join}from'node:path';
import{describe,expect,it}from'vitest';
import{NodeKernelHost}from'../src/node-kernel-host';
import{findRepoRoot,tryResolveBinary}from'../src/binary-resolver';
const repo=findRepoRoot(),partial=join(repo,'local-binaries/partial');
const manifestPath=join(partial,'partial.json');
const manifest:{file:string;selection:string[]}|null=existsSync(manifestPath)?JSON.parse(readFileSync(manifestPath,'utf8')):null;
const kernel=tryResolveBinary('kernel.wasm');
const available=!!kernel&&['rust-docs','mandoc-browser-bundle'].every(name=>manifest?.selection.includes(name));
if(!available&&process.env.KANDELO_REQUIRE_RUST_MANUALS==='1')throw Error('Build a partial shell with rust-docs and mandoc-browser-bundle before Rust manual acceptance');
describe.skipIf(!available)('Rust manuals in the shell',()=>{
 it('loads matching upstream pages lazily through man lookup and rendering',async()=>{
  const image=new Uint8Array(readFileSync(join(partial,manifest!.file)));
  let stdout='',stderr='';
  const host=new NodeKernelHost({rootfsImage:image,onStdout:(_pid,data)=>{stdout+=new TextDecoder().decode(data);},onStderr:(_pid,data)=>{stderr+=new TextDecoder().decode(data);}});
  const pages=['cargo','cargo-test','rustc','rustdoc'];
  const script=['set -eu',...pages.flatMap(page=>[`printf '\\nMAN_BEGIN_${page}\\n'`,`MANPAGER=cat man 1 ${page}`,`printf '\\nMAN_END_${page}\\n'`])].join('\n');
  try{
   await host.init(new Uint8Array(readFileSync(kernel!)).buffer);
   const {exit}=await host.spawnFromVfs('/bin/bash',['bash','-lc',script],{uid:1000,gid:1000,env:['HOME=/home/maker','USER=maker','LOGNAME=maker','TERM=xterm']});
   const status=await exit;
   expect(status,stderr).toBe(0);
   const rendered=stdout.replace(/.\x08/g,'');
   for(const page of pages){
    const content=rendered.split(`MAN_BEGIN_${page}\n`)[1]?.split(`MAN_END_${page}`)[0];
    expect(content,page).toContain('NAME');expect(content,page).toContain('SYNOPSIS');
    expect(content,page).not.toContain('.TH');expect(content,page).not.toContain('.SH');
   }
  }finally{await host.destroy();}
 },90000);
});
