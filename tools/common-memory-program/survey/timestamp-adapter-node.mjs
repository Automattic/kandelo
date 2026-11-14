import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {loadavg} from 'node:os';
import {statMicroTrial,parseStatMicro} from './timestamp-stat-micro.mjs';
const [manifestArg,indexText,outArg]=process.argv.slice(2),m=JSON.parse(readFileSync(manifestArg,'utf8')),c=m.microCases[Number(indexText)],out=resolve(outArg);
mkdirSync(out,{recursive:false});const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const profile=m.profiles[c.variant],artifact=c.label==='native-file'?m.nativeCli:m.vmCli;
const {NodeKernelHost}=await import(pathToFileURL(resolve(profile,'node-kernel-host.mjs')).href);
const r={...c,profile,runtime:process.version,flags:process.execArgv,kernelSha256:sha(m.kernel),artifactSha256:sha(artifact),stdout:'',stderr:'',diagnostics:[],loadBefore:loadavg()};
const host=new NodeKernelHost({rootfsImage:readFileSync(m.image),maxWorkers:4,onStdout:(_pid,b)=>r.stdout+=new TextDecoder().decode(b),onStderr:(_pid,b)=>r.stderr+=new TextDecoder().decode(b),onHostDiagnostic:e=>r.diagnostics.push(e)});
try{await host.init(Uint8Array.from(readFileSync(m.kernel)).buffer);r.trial=await statMicroTrial(host,Uint8Array.from(readFileSync(artifact)).buffer);r.micro=parseStatMicro(r.stdout);}
catch(e){r.error=String(e.stack||e);}
finally{await host.destroy();r.destroyed=true;r.loadAfter=loadavg();writeFileSync(resolve(out,'result.json'),JSON.stringify(r,null,2)+'\n');}
if(r.error||r.stderr||r.diagnostics.length||!r.micro?.passed)throw Error('adapter micro failed: '+JSON.stringify(r));
console.log(JSON.stringify({passed:true,...c}));
