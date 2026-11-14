import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:false});
const loop=load=>`(local $i i32)(local $sum i64)
(block $done (loop $loop
 (br_if $done (i32.ge_u (local.get $i)(local.get $n)))
 (local.set $sum (i64.add (local.get $sum)(i64.extend_i32_u ${load})))
 (local.set $i (i32.add(local.get $i)(i32.const 1)))(br $loop))) (local.get $sum)`;
const address='(i32.add(local.get $base)(i32.shl(i32.and(local.get $i)(i32.const 32767))(i32.const 2)))';
const func=(name,load)=>`(func(export "${name}")(param $n i32)(param $base i32)(result i64)${loop(load)})`;
writeFileSync(out+'/single.wat',`(module(import "env" "memory"(memory 2 65536 shared))${func('sum',`(i32.load ${address})`)})`);
writeFileSync(out+'/dual.wat',`(module(import "env" "private"(memory $private 2 65536 shared))(import "env" "shared"(memory $shared 2 65536 shared))
${func('private',`(i32.load $private ${address})`)}
${func('shared',`(i32.load $shared ${address})`)}
${func('tagged',`(if(result i32)(i32.lt_u ${address}(i32.const -2147483648))(then(i32.load $private ${address}))(else(i32.load $shared(i32.and ${address}(i32.const 2147483647)))))`)})`);
const commands=[];function run(args){const r=spawnSync(args[0],args.slice(1),{encoding:'utf8'});commands.push({args,exit:r.status,stdout:r.stdout,stderr:r.stderr});writeFileSync(out+'/commands.json',JSON.stringify(commands,null,2)+'\n');if(r.status!==0)throw Error(r.stderr);}
for(const name of ['single','dual'])run(['wat2wasm','--enable-threads','--enable-multi-memory',out+'/'+name+'.wat','-o',out+'/'+name+'.wasm']);
const host=spawnSync('rustc',['-vV'],{encoding:'utf8'}).stdout.split('host: ')[1].split('\n')[0];
const helper=resolve('.scratch/common-memory-survey-fused-1/helpers-fuse-small.wasm');
run([resolve('tools/common-memory-program/instrument/target',host,'debug/common-memory-program-instrument'),out+'/single.wasm',helper,out+'/single-vm.wasm','--outline-accesses','--fuse-scalars=small']);
writeFileSync(out+'/inputs.json',JSON.stringify(Object.fromEntries([import.meta.filename,helper,...['single.wasm','dual.wasm','single-vm.wasm'].map(n=>out+'/'+n)].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')])),null,2)+'\n');
