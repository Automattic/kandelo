// Source-checkout-only opt-in profile. Ordinary package exports stay unchanged.
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

if (!process.env.KANDELO_DEV_SHELL_TOOL_PATH) throw Error('Run through scripts/dev-shell.sh');
const args=process.argv.slice(2);
if(args.length!==1) throw Error('usage: node host/build-common-memory.mjs FRESH_OUTPUT_DIRECTORY');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(args[0]);
await mkdir(out,{recursive:true});
if((await readdir(out)).length) throw Error('Use a fresh output directory; preserve existing profiles.');
const flags=['--direct-clocks','--clock-renew-after-stat','--native-network','--pregrow-group','--sparse-fork-backing','--reuse-unmapped-pages','--retire-generations','--short-records=64'];
const result=spawnSync(process.execPath,[resolve(root,'tools/common-memory-program/platform/build.mjs'),out,...flags],{cwd:root,stdio:'inherit'});
if(result.error) throw result.error;
if(result.status!==0) process.exit(result.status??1);
const inputs=JSON.parse(await readFile(resolve(out,'profile-inputs.json'),'utf8'));
inputs.inputs['host/build-common-memory.mjs']=createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
const artifacts={};
for(const file of (await readdir(out)).filter(f=>f.endsWith('.mjs')).sort())
    artifacts[file]=createHash('sha256').update(await readFile(resolve(out,file))).digest('hex');
await writeFile(resolve(out,'common-memory-profile.json'),JSON.stringify({
    format:'kandelo-experimental-common-memory-v2',status:'acceptance-in-progress',
    processModel:'trusted-memory32-prefork-one-worker-per-process',
    kernelCapability:'kernel_configure_process_memory_model',
    memoryModel:2,translatedContractFormat:2,cooperativeStop:1,
    stopCapability:'kernel_shared_group_stop_protocol_version',
    nodeNetworking:'normal-host-bridge',directClock:'opt-in-v1-with-vm-metadata-renewal',groupMaximumBytes:512*1024*1024,
    unsupported:['pthread/clone','vfork','file-backed MAP_SHARED','untranslated side modules'],
    flags,inputs:inputs.inputs,artifacts,
},null,2)+'\n');
console.log(`Experimental common-memory profile: ${out}`);
