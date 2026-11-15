import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
const [fixture,profile,output]=process.argv.slice(2).map(p=>resolve(p));
mkdirSync(output,{recursive:true});
const manifest=JSON.parse(readFileSync(resolve(fixture,'manifest.json'))),runs=[];
for(const [mode,artifact] of [...Object.entries(manifest.variants).map(([m,a])=>[m,a.path]),['ordinary-negative',manifest.native]]) {
 const args=['tools/common-memory-program/platform/run-php.mjs',profile,artifact,resolve(output,mode),mode==='ordinary-negative'?'shared-fork-native':'shared-fork'];
 const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:200000});
 writeFileSync(resolve(output,mode+'.log'),(result.stdout??'')+(result.stderr??''));
 runs.push({mode,args,exit:result.status,signal:result.signal,error:result.error?String(result.error):undefined});
 writeFileSync(resolve(output,'runs.json'),JSON.stringify(runs,null,2)+'\n');
 if(result.status!==0)throw Error(`${mode} real object fork failed`);
 console.log(mode+' passed');
}
