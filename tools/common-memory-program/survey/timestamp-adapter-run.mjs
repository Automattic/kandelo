import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {loadavg} from 'node:os';
const [manifestArg,stage,outArg]=process.argv.slice(2),manifestPath=resolve(manifestArg),m=JSON.parse(readFileSync(manifestPath,'utf8')),out=resolve(outArg);
if(!['micro','gate','timing'].includes(stage))throw Error('invalid stage');mkdirSync(out,{recursive:false});
const verify=()=>{for(const[p,h]of Object.entries(m.inputs))if(createHash('sha256').update(readFileSync(p)).digest('hex')!==h)throw Error('frozen input changed: '+p);};
verify();writeFileSync(resolve(out,'manifest.json'),JSON.stringify(m,null,2)+'\n');const rows=[];
for(const[index,c]of m[stage+'Cases'].entries()){
 const dest=resolve(out,'node-'+index),artifact=c.label==='native-file'?m.nativeFpm:m.vmFpm;
 const argv=stage==='micro'?['tools/common-memory-program/survey/timestamp-adapter-node.mjs',manifestPath,String(index),dest]:['--import','tsx/esm','tools/common-memory-program/survey/wordpress-node.ts',m.profiles[c.variant],m.image,artifact,dest,c.label,c.backend];
 const row={...c,index,stage,argv,startedAt:new Date().toISOString(),loadBefore:loadavg()};
 const run=spawnSync(process.execPath,argv,{env:{...process.env,KANDELO_SURVEY_KERNEL:m.kernel,KANDELO_SURVEY_VALIDATE_TIMESTAMPS:'1',KANDELO_SURVEY_CHECK_TIMESTAMP_POLICY:stage==='gate'?'1':'0',KANDELO_SURVEY_WARMUP:stage==='timing'?'2':'0',KANDELO_SURVEY_ROUNDS:stage==='timing'?'5':'1',KANDELO_SURVEY_SEED:'6197'},encoding:'utf8',timeout:320000});
 Object.assign(row,{exit:run.status,signal:run.signal,error:run.error?String(run.error):undefined,finishedAt:new Date().toISOString(),loadAfter:loadavg()});
 writeFileSync(resolve(out,'node-'+index+'.log'),(run.stdout??'')+(run.stderr??''));rows.push(row);writeFileSync(resolve(out,'node-runs.json'),JSON.stringify(rows,null,2)+'\n');console.log(JSON.stringify({host:'node',stage,index,exit:run.status}));
}
const browser=resolve(out,'browser');mkdirSync(browser);const argv=['node_modules/playwright/cli.js','test','--config','tools/common-memory-program/survey/timestamp-adapter.config.ts','--max-failures=0'];
const run=spawnSync(process.execPath,argv,{env:{...process.env,KANDELO_TIMESTAMP_ADAPTER_MANIFEST:manifestPath,KANDELO_TIMESTAMP_ADAPTER_STAGE:stage,KANDELO_COMMON_MEMORY_ARTIFACTS:browser},encoding:'utf8',timeout:4*3600000});
writeFileSync(resolve(out,'browser.log'),(run.stdout??'')+(run.stderr??''));writeFileSync(resolve(out,'browser-run.json'),JSON.stringify({argv,exit:run.status,signal:run.signal,error:run.error?String(run.error):undefined},null,2)+'\n');
const receipt={passed:run.status===0&&rows.every(r=>r.exit===0),stage,parents:m[stage+'Cases'].length*4};
try{verify();receipt.inputsVerified=Object.keys(m.inputs).length;}catch(e){receipt.passed=false;receipt.inputError=String(e);}
writeFileSync(resolve(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');if(!receipt.passed)throw Error('adapter matrix failed; evidence retained');console.log(JSON.stringify(receipt));
