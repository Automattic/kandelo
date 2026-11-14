// ARCH01 synthetic memory32 pointer ABI cost screen, no SDK/PHP integration.
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:false});
const pointer='(i32.load (i32.add (local.get $table) (i32.shl (i32.and (local.get $i) (i32.const 32767)) (i32.const 2))))';
const direct='(i32.load (local.get $p))';
const load=dual=>`(if (result i32) (i32.ge_s (local.get $p) (i32.const 0))
 (then (i32.load ${dual?'$private ':''}(local.get $p)))
 (else (i32.load ${dual?'$shared ':''}(i32.add (i32.and (local.get $p) (i32.const 2147483647)) (i32.const ${dual?0:131072})))))`;
const store=(dual,value)=>`(if (i32.ge_s (local.get $p) (i32.const 0))
 (then (i32.store ${dual?'$private ':''}(local.get $p) ${value}))
 (else (i32.store ${dual?'$shared ':''}(i32.add (i32.and (local.get $p) (i32.const 2147483647)) (i32.const ${dual?0:131072})) ${value})))`;
function loop(name,tagged,dual,write) {
 const get=tagged?load(dual):direct;
 const put=tagged?store(dual,'(i32.xor (local.get $old) (i32.const 1515870810))'):'(i32.store (local.get $p) (i32.xor (local.get $old) (i32.const 1515870810)))';
 return `(func (export "${name}") (param $n i32) (param $table i32) (result i64)
 (local $i i32) (local $p i32) (local $old i32) (local $sum i64)
 (block $done (loop $again
  (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
  (local.set $p ${pointer})
  (local.set $old ${get})
  ${write?put:''}
  (local.set $sum (i64.add (local.get $sum) (i64.extend_i32_u (local.get $old))))
  (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $again))) (local.get $sum))`;
}
const single=`(module (import "env" "memory" (memory 8 16 shared))
 ${loop('read',false,false,false)} ${loop('write',false,false,true)}
 ${loop('tagged_read',true,false,false)} ${loop('tagged_write',true,false,true)}
 (func (export "load") (param $p i32) (result i32) ${direct})
 (func (export "store") (param $p i32) (param $v i32) (i32.store (local.get $p) (local.get $v))))`;
const dual=`(module (import "env" "private" (memory $private 8 16 shared))
 (import "env" "shared" (memory $shared 8 16 shared))
 ${loop('read',true,true,false)} ${loop('write',true,true,true)}
 (func (export "load") (param $p i32) (result i32) ${load(true)})
 (func (export "store") (param $p i32) (param $v i32) ${store(true,'(local.get $v)')})
 (func (export "raw") (param $p i32) (result i32) (i32.load $private (local.get $p))))`;
const commands=[];
function run(args){const r=spawnSync(args[0],args.slice(1),{encoding:'utf8'});commands.push({args,exit:r.status,stdout:r.stdout,stderr:r.stderr});writeFileSync(resolve(out,'commands.json'),JSON.stringify(commands,null,2)+'\n');if(r.status!==0)throw Error(r.stderr);}
for(const[name,wat]of Object.entries({single,dual})){
 writeFileSync(resolve(out,name+'.wat'),wat);
 run(['wat2wasm','--enable-threads','--enable-multi-memory',resolve(out,name+'.wat'),'-o',resolve(out,name+'.wasm')]);
 run(['wasm-validate','--enable-threads','--enable-multi-memory',resolve(out,name+'.wasm')]);
}
const tool=resolve('tools/common-memory-program/instrument/target/aarch64-apple-darwin/debug/common-memory-program-instrument');
const helper=resolve('.scratch/common-memory-survey-fused-1/helpers-fuse-small.wasm');
run([tool,resolve(out,'single.wasm'),helper,resolve(out,'single-vm.wasm'),'--outline-accesses','--fuse-scalars=small']);
run(['wasm-validate','--enable-threads','--enable-multi-memory',resolve(out,'single-vm.wasm')]);
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
writeFileSync(resolve(out,'inputs.json'),JSON.stringify(Object.fromEntries([import.meta.filename,tool,helper,...['single.wasm','dual.wasm','single-vm.wasm','single.wat','dual.wat'].map(n=>resolve(out,n))].map(p=>[p,hash(p)])),null,2)+'\n');
console.log(JSON.stringify({passed:true,out,commands:commands.length}));
