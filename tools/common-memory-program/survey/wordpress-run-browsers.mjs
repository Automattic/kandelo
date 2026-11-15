import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {wordpressPlan} from './wordpress-plan.mjs';
import {wordpressInputs,wordpressIdentities,verifyWordpressInputs} from './wordpress-inputs.mjs';
const [variants,profile,image,native,output,backend='sqlite']=process.argv.slice(2).map((v,i)=>i<5?resolve(v):v);
if(existsSync(output))throw Error('choose a fresh output directory');mkdirSync(output,{recursive:true});
const manifest=JSON.parse(readFileSync(resolve(variants,'manifest.json')));
const modes=(process.env.KANDELO_SURVEY_MODES??'baseline,baseline-conditional,scalar,scalar-conditional').split(',');
const plan=wordpressPlan(modes),inputs=wordpressInputs(variants,profile,image,native,manifest,modes);
writeFileSync(resolve(output,'inputs.json'),JSON.stringify({inputs,plan,backend,runtime:process.version,flags:process.execArgv,
  identities:wordpressIdentities(inputs,image,native,manifest,modes)},null,2)+'\n');
const args=['node_modules/playwright/cli.js','test','--config','tools/common-memory-program/survey/wordpress.config.ts','--max-failures=1'];
const result=spawnSync(process.execPath,args,{env:{...process.env,KANDELO_SURVEY_VARIANTS:variants,
  KANDELO_COMMON_MEMORY_PROFILE:profile,KANDELO_SURVEY_IMAGE:image,KANDELO_COMMON_MEMORY_NATIVE_FPM:native,
  KANDELO_COMMON_MEMORY_ARTIFACTS:output,KANDELO_SURVEY_BACKEND:backend},encoding:'utf8',timeout:3600000});
writeFileSync(resolve(output,'run.log'),(result.stdout??'')+(result.stderr??''));
writeFileSync(resolve(output,'run.json'),JSON.stringify({args,exit:result.status,signal:result.signal,error:result.error?String(result.error):undefined},null,2)+'\n');
if(result.status!==0)throw Error('WordPress browser matrix failed');
verifyWordpressInputs(inputs);
console.log('Matched WordPress browser controls passed with frozen inputs.');
