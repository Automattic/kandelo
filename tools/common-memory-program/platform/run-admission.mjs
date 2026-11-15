import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const args=process.argv.slice(2);
if(args.length!==7) throw Error('usage: run-admission.mjs PROFILE KERNEL IMAGE PROGRAM grouped|ordinary|old-kernel EXPECTED_EXIT OUTPUT');
const [profile,kernel,image,program]=args.slice(0,4).map(p=>resolve(p));
const [mode,expected]=args.slice(4,6),output=resolve(args[6]);
assert.ok(['grouped','ordinary','old-kernel'].includes(mode));
await mkdir(output,{recursive:true});
const {NodeKernelHost}=await import(pathToFileURL(resolve(profile,'node-kernel-host.mjs')));
const result={mode,stdout:'',stderr:'',diagnostics:[]};
const host=new NodeKernelHost({rootfsImage:await readFile(image),maxWorkers:4,
    onStdout:(_pid,b)=>{result.stdout+=new TextDecoder().decode(b);},
    onStderr:(_pid,b)=>{result.stderr+=new TextDecoder().decode(b);},
    onHostDiagnostic:e=>result.diagnostics.push(e),
});
const deadline=setTimeout(()=>{result.timeout=true;void host.destroy();},60000);
try {
    await host.init(Uint8Array.from(await readFile(kernel)).buffer);
    try {
        result.code=await host.spawn(Uint8Array.from(await readFile(program)).buffer,['admission',mode==='ordinary'?'ordinary':'grouped'],
            {env:['PATH=/usr/bin:/bin','HOME=/home/maker','TMPDIR=/tmp'],cwd:'/tmp',uid:1000,gid:1000,stdin:new Uint8Array()});
    } catch(error) {result.error=String(error.stack||error);}
    if(mode==='old-kernel') {
        assert.match(result.error??JSON.stringify(result.diagnostics),/Kernel lacks shared-group memory admission/);
        assert.equal(result.stdout,'');
    } else {
        assert.equal(result.error,undefined);assert.equal(result.code,Number(expected));
        assert.match(result.stdout,new RegExp('PASS '+(mode==='ordinary'?'ordinary control':'grouped admission')));
        assert.equal(result.stderr,'');assert.deepEqual(result.diagnostics,[]);
    }
    result.passed=true;
} finally {
    clearTimeout(deadline);await host.destroy();
    await writeFile(resolve(output,'result.json'),JSON.stringify(result,null,2)+'\n');
}
console.log(JSON.stringify(result));
