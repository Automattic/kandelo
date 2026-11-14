import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const [outArg,profileRootArg]=process.argv.slice(2),out=resolve(outArg),profileRoot=resolve(profileRootArg);mkdirSync(out,{recursive:false});
const old=JSON.parse(readFileSync('.scratch/timestamp-stat-plan-1/manifest.json','utf8'));
const m={scope:'TS-03 host scalar adapters individually; no stat-reuse combination. Current-time validation ON/revalidate_freq0. Private experiment, not production acceptance.',
 profiles:Object.fromEntries(['baseline','dataview','typed'].map(k=>[k,resolve(profileRoot,k)])),kernel:old.kernels.baseline,
 image:old.image,vmFpm:old.vmFpm,nativeFpm:old.nativeFpm,vmCli:old.vmCli,nativeCli:old.nativeCli,
 microCases:[],gateCases:[],timingCases:[]};
for(let cohort=0;cohort<2;cohort++){
 const order=cohort?['typed','dataview','baseline']:['baseline','dataview','typed'];
 const micro=[...order.map(variant=>({variant,label:'native-file',cohort})),...order.map(variant=>({variant,label:'vm-shared',cohort}))];
 m.microCases.push(...micro);
 const native=order.map(variant=>({variant,label:'native-file',cohort,backend:'sqlite'}));
 m.timingCases.push(...native,...order.map(variant=>({variant,label:'vm-shared',cohort,backend:'sqlite'})),...native.toReversed());
}
for(const variant of ['dataview','typed'])for(const backend of ['sqlite','mariadb'])for(const label of ['native-file','vm-shared'])m.gateCases.push({variant,label,backend});
const files=[m.image,m.vmFpm,m.nativeFpm,m.vmCli,m.nativeCli,m.kernel,'Cargo.lock',
 ...Object.values(m.profiles).flatMap(p=>readdirSync(p).map(f=>resolve(p,f))),
 ...['survey','platform'].flatMap(d=>readdirSync('tools/common-memory-program/'+d).filter(p=>/\.(mjs|ts)$/.test(p)).map(p=>resolve('tools/common-memory-program',d,p)))];
for(const[variant,profile]of Object.entries(m.profiles)){
 const p=JSON.parse(readFileSync(resolve(profile,'profile-inputs.json'),'utf8'));
 for(const[path,h]of Object.entries(p.inputs))if(createHash('sha256').update(readFileSync(path)).digest('hex')!==h)throw Error('stale profile input: '+path);
 if(p.groupInitialPages!=='maximumPages')throw Error('expected pregrown comparison');
 if((p.shortScalars??'baseline')!==variant)throw Error('wrong scalar mode');
 for(const k of ['byteSlices','metadataDiagnostics','accessDiagnostics','syscallDiagnostics','workerProfileDiagnostics'])if(p[k])throw Error('unexpected factor: '+k);
}
m.inputs=Object.fromEntries(files.map(p=>[resolve(p),createHash('sha256').update(readFileSync(p)).digest('hex')]));
writeFileSync(resolve(out,'manifest.json'),JSON.stringify(m,null,2)+'\n');console.log(JSON.stringify({out,inputs:Object.keys(m.inputs).length,cases:{micro:m.microCases.length*4,gate:m.gateCases.length*4,timing:m.timingCases.length*4}}));
