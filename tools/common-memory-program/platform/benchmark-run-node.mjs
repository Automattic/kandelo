import {spawnSync} from 'node:child_process';
import {mkdirSync,existsSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {loadavg} from 'node:os';
const [profile,native,virtual,output]=process.argv.slice(2).map(p=>resolve(p));
if(existsSync(output)) throw Error('choose a fresh benchmark output directory');
mkdirSync(output,{recursive:true});
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const files=[native,virtual,'local-binaries/partial/shell-partial.vfs.zst','local-binaries/source-only-v1/kernel.wasm',
  'tools/common-memory-program/instrument/src/main.rs','tools/common-memory-program/instrument/Cargo.lock','tools/common-memory-program/helpers.c',
  ...readdirSync('tools/common-memory-program/platform').filter(p=>p.endsWith('.mjs') || p.endsWith('.ts')).map(p=>resolve('tools/common-memory-program/platform',p)),
  ...readdirSync(profile).map(p=>resolve(profile,p)),
];
const inputs=Object.fromEntries(files.map(file=>[file,hash(file)]));
writeFileSync(resolve(output,'inputs.json'),JSON.stringify({inputs,runtime:process.version,flags:process.execArgv,load:loadavg()},null,2)+'\n');
const orders=[['native-file','vm-shared','vm-file','native-file'],['native-file','vm-file','vm-shared','native-file']];
const runs=[];
for(let cohort=0;cohort<orders.length;cohort++) for(const [order,label] of orders[cohort].entries()) {
  const out=resolve(output,`node-${cohort}-${order}-${label}`);
  const run={cohort,order,label,output:out,loadBefore:loadavg(),startedAt:new Date().toISOString()};
  // A new Node parent process per control: no compiled guest code is reused
  // across cohorts, controls or the bracketing ordinary-addressing trials.
  const result=spawnSync(process.execPath,['tools/common-memory-program/platform/benchmark-node.mjs',profile,native,virtual,out,label],
    {env:{...process.env,KANDELO_BENCH_SEED:String(6197+cohort)},encoding:'utf8',timeout:250000});
  run.exit=result.status;run.signal=result.signal;run.loadAfter=loadavg();run.finishedAt=new Date().toISOString();
  if(result.error)run.error=String(result.error);
  writeFileSync(resolve(output,`node-${cohort}-${order}-${label}.log`),(result.stdout??'')+(result.stderr??''));
  runs.push(run);writeFileSync(resolve(output,'runs.json'),JSON.stringify(runs,null,2)+'\n');
  console.log(JSON.stringify(run));
  if(result.status!==0) throw Error(`benchmark child failed: ${out}`);
}
for(const [file,digest] of Object.entries(inputs))if(hash(file)!==digest)throw Error(`benchmark input changed: ${file}`);
console.log('All Node controls passed with frozen inputs.');
