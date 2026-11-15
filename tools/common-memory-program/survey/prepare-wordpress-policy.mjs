// APP-02 changes configuration only. Both VM cases use the same existing
// small-fusion module; their ordinary controls use the same existing compiler.
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const [control,profile,native,output]=process.argv.slice(2).map(p=>resolve(p));
if(existsSync(output))throw Error('choose a fresh output directory');
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const artifact=p=>({path:p,bytes:statSync(p).size,sha256:sha(p)});
const original=JSON.parse(readFileSync(control)),vm=original.variants['fuse-small'];
if(!vm)throw Error('requires existing small-fusion control');
for(const a of Object.values(vm.artifacts))if(sha(a.path)!==a.sha256||statSync(a.path).size!==a.bytes)throw Error('control artifact changed');
const ordinary=artifact(native),profileArtifacts=Object.fromEntries(readdirSync(profile).map(name=>[name,artifact(resolve(profile,name))]));
mkdirSync(output,{recursive:true});
writeFileSync(resolve(output,'manifest.json'),JSON.stringify({scope:'APP-02 timestamp policy only, identical small-fusion VM and ordinary compiler; no rebuilt program/host/image',
  sources:{[control]:sha(control),[fileURLToPath(import.meta.url)]:sha(fileURLToPath(import.meta.url))},
  variants:{baseline:{...vm},'timestamps-off':{...vm,ids:[...(vm.ids??[]),'APP-02']}},
  pairReferences:{'timestamps-off':'baseline'},nativeArtifacts:{baseline:ordinary,'timestamps-off':ordinary},
  hostProfiles:{baseline:profile,'timestamps-off':profile},profileArtifacts:{[profile]:profileArtifacts},
  appOptions:{baseline:{validateTimestamps:true},'timestamps-off':{validateTimestamps:false}}},null,2)+'\n');
console.log(`Prepared identical-code policy controls at ${output}`);
