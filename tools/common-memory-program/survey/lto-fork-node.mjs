import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const [profile,artifact,output,controlJson]=process.argv.slice(2),control=JSON.parse(controlJson);
mkdirSync(output,{recursive:true});
const {NodeKernelHost}=await import(pathToFileURL(resolve(profile,'node-kernel-host.mjs')));
const result={runtime:process.version,flags:process.execArgv,control,stdout:'',stderr:'',diagnostics:[],passed:false};
const host=new NodeKernelHost({rootfsImage:readFileSync('local-binaries/partial/shell-partial.vfs.zst'),maxWorkers:4,
 onStdout:(_pid,data)=>result.stdout+=new TextDecoder().decode(data),
 onStderr:(_pid,data)=>result.stderr+=new TextDecoder().decode(data),
 onHostDiagnostic:event=>result.diagnostics.push(event)});
const deadline=setTimeout(()=>{result.deadline=true;void host.destroy();},60000);
try {
 await host.init();
 const bytes=readFileSync(artifact);result.artifactSha256=createHash('sha256').update(bytes).digest('hex');
 result.exit=await host.spawn(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),
  ['lto-fork','fork',control.shared?'shared':'private'],
  {cwd:'/tmp',env:['PATH=/usr/bin:/bin','HOME=/home/maker','TMPDIR=/tmp'],uid:1000,gid:1000,stdin:new Uint8Array()});
 result.memory=await host.commonMemoryPrototypeStats();
 // These are current process-table entries after waitpid/exit teardown,
 // not a count of every address space created. Guest state checks plus
 // frozen native/VM identities and the shared positive/negative pair prove
 // the address model; preserve lifecycle-sensitive stats as diagnostics.
 if(result.exit!==control.expectedExit||result.stdout.includes('PASS LTO fork:')!==(control.expectedExit===0)||
    result.stderr||result.diagnostics.length||result.deadline)
  throw Error('LTO real fork result/diagnostics mismatch');
 result.passed=true;
}catch(error){result.error=String(error)+'\n'+String(error.stack||'');}
finally{clearTimeout(deadline);await host.destroy();result.destroyed=true;
 writeFileSync(resolve(output,'result.json'),JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify(result));
if(!result.passed)process.exitCode=1;
