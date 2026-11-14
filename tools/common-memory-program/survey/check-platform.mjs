import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
const [variants,profile,output]=process.argv.slice(2).map(p=>resolve(p));
mkdirSync(output,{recursive:true});
const manifest=JSON.parse(readFileSync(resolve(variants,'manifest.json'))),runs=[];
for(const [mode,{artifacts}] of Object.entries(manifest.variants)) {
  for(const kind of ['fork','fpm']) {
    const out=resolve(output,mode,kind);
    const script=kind==='fork'?'run-php.mjs':'run-fpm.mjs';
    const args=[`tools/common-memory-program/platform/${script}`,profile,artifacts[kind].path,out,kind==='fork'?'shared-fork':'shared'];
    const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:200000});
    writeFileSync(resolve(output,`${mode}-${kind}.log`),(result.stdout??'')+(result.stderr??''));
    runs.push({mode,kind,args,exit:result.status,signal:result.signal,error:result.error?String(result.error):undefined});
    writeFileSync(resolve(output,'runs.json'),JSON.stringify(runs,null,2)+'\n');
    if(result.status!==0)throw Error(`${mode} ${kind} failed`);
    console.log(`${mode} ${kind}: passed`);
  }
}
