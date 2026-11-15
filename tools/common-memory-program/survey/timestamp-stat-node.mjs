import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {loadavg} from 'node:os';
import {statMicroTrial,parseStatMicro} from './timestamp-stat-micro.mjs';
const [manifestPath,indexText,out]=process.argv.slice(2);mkdirSync(out,{recursive:true});
const manifest=JSON.parse(readFileSync(manifestPath,'utf8')),trial=manifest.microCases[Number(indexText)];
const kernel=manifest.kernels[trial.kernel],artifact=trial.label==='native-file'?manifest.nativeCli:manifest.vmCli;
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const {NodeKernelHost}=await import(pathToFileURL(resolve(manifest.profile,'node-kernel-host.mjs')).href);
const result={...trial,runtime:process.version,flags:process.execArgv,kernelSha256:sha(kernel),artifactSha256:sha(artifact),stdout:'',stderr:'',diagnostics:[],loadBefore:loadavg()};
const save=()=>writeFileSync(resolve(out,'result.json'),JSON.stringify(result,null,2)+'\n');
const host=new NodeKernelHost({rootfsImage:readFileSync(manifest.image),maxWorkers:4,
 onStdout:(_pid,b)=>{result.stdout+=new TextDecoder().decode(b);},onStderr:(_pid,b)=>{result.stderr+=new TextDecoder().decode(b);},onHostDiagnostic:e=>result.diagnostics.push(e)});
try {await host.init(Uint8Array.from(readFileSync(kernel)).buffer);result.trial=await statMicroTrial(host,Uint8Array.from(readFileSync(artifact)).buffer);result.micro=parseStatMicro(result.stdout);}
catch(error){result.error=String(error.stack||error);}
finally{await host.destroy();result.destroyed=true;result.loadAfter=loadavg();save();}
if(result.error||result.stderr||result.diagnostics.length||!result.micro?.passed)throw Error('micro failed: '+JSON.stringify(result));
console.log(JSON.stringify({passed:true,kernel:trial.kernel,label:trial.label}));
