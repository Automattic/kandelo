import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:false});
const old=JSON.parse(readFileSync('.scratch/common-memory-byte-timestamps-variants-1/manifest.json','utf8')),mode='baseline-outlined';
const m={scope:'Kernel-owned stat reuse, baseline/candidate kernels, unchanged PHP O2 CALL outlined/helperO2 and plain host profile. Timestamp validation ON and revalidate_freq0. All cases fresh parents; no counters in timings.',
 profile:old.hostProfiles[mode],image:resolve('.scratch/common-memory-wordpress-empty-cache-2/wordpress.vfs.zst'),
 vmFpm:old.variants[mode].artifacts.fpm.path,nativeFpm:old.nativeArtifacts[mode].path,
 vmCli:old.cliArtifacts[mode].path,nativeCli:old.nativeCliArtifacts[mode].path,
 kernels:{baseline:resolve('.scratch/timestamp-stat-baseline-1/kandelo-kernel.wasm'),candidate:resolve('.scratch/timestamp-stat-candidate-2/kandelo-kernel.wasm')},
 microCases:[],gateCases:[],timingCases:[]};
for(let cohort=0;cohort<2;cohort++) {
 let cases=[['baseline','native-file'],['baseline','vm-shared'],['candidate','vm-shared'],['candidate','native-file']];if(cohort)cases.reverse();
 for(const[kernel,label]of cases)m.microCases.push({kernel,label,cohort});
 const vm=cohort?[['candidate','vm-shared'],['baseline','vm-shared']]:[['baseline','vm-shared'],['candidate','vm-shared']];
 const native=cohort?[['candidate','native-file'],['baseline','native-file']]:[['baseline','native-file'],['candidate','native-file']];
 for(const[kernel,label]of [...native,...vm,...native.toReversed()])m.timingCases.push({kernel,label,cohort,backend:'sqlite'});
}
for(const backend of ['sqlite','mariadb'])for(const label of ['native-file','vm-shared'])m.gateCases.push({kernel:'candidate',label,backend});
const profile=JSON.parse(readFileSync(resolve(m.profile,'profile-inputs.json'),'utf8'));
for(const flag of ['accessDiagnostics','syscallDiagnostics','workerProfileDiagnostics','byteSliceDiagnostics','metadataDiagnostics'])if(profile[flag])throw Error('diagnostic profile');
const files=[m.image,m.vmFpm,m.nativeFpm,m.vmCli,m.nativeCli,...Object.values(m.kernels),
 ...readdirSync(m.profile).map(p=>resolve(m.profile,p)),
 ...readdirSync('tools/common-memory-program/survey').filter(p=>/\.(mjs|ts)$/.test(p)).map(p=>resolve('tools/common-memory-program/survey',p)),
 'crates/runtime-core/src/syscalls.rs','Cargo.lock','.scratch/timestamp-stat-baseline-1/syscalls.rs'];
m.inputs=Object.fromEntries(files.map(p=>[resolve(p),createHash('sha256').update(readFileSync(p)).digest('hex')]));
m.artifacts=Object.fromEntries(['vmFpm','nativeFpm','vmCli','nativeCli','image'].map(k=>[k,m.inputs[resolve(m[k])]]));
m.kernelSha256=Object.fromEntries(Object.entries(m.kernels).map(([k,p])=>[k,m.inputs[p]]));
if(m.kernelSha256.baseline===m.kernelSha256.candidate)throw Error('identical kernel bytes');
writeFileSync(resolve(out,'manifest.json'),JSON.stringify(m,null,2)+'\n');console.log(JSON.stringify({out,kernels:m.kernelSha256,cases:{micro:m.microCases.length,gate:m.gateCases.length,timing:m.timingCases.length}}));
