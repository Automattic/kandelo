// No guest rebuild: isolate VM-05 host adaptation with exact original/fused Wasm.
import {readFileSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const [output,candidateProfile]=process.argv.slice(2).map(p=>resolve(p));
mkdirSync(output,{recursive:false});
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const artifact=path=>({path,sha256:sha(path),bytes:readFileSync(path).byteLength});
const baselineProfile=resolve('.scratch/common-memory-survey-postopt-pregrown-profile-1');
const reproducedProfile=resolve('.scratch/common-memory-survey-byte-profile-baseline-1');
const original=JSON.parse(readFileSync('.scratch/common-memory-survey-object-regions-1/manifest.json'));
const candidateInputs=JSON.parse(readFileSync(resolve(candidateProfile,'profile-inputs.json')));
if(candidateInputs.byteSlices!=='pristine-byte-slice-v1'||candidateInputs.groupInitialPages!=='maximumPages'||candidateInputs.byteSliceDiagnostics)
 throw Error('wrong byte-slice/pregrown candidate profile');
const reproduction={};
for(const name of readdirSync(baselineProfile).filter(p=>p.endsWith('.mjs'))) {
 const expected=sha(resolve(baselineProfile,name)),actual=sha(resolve(reproducedProfile,name));
 if(expected!==actual)throw Error('default profile bundle changed: '+name);
 reproduction[name]=expected;
}
if(Object.keys(reproduction).length!==6)throw Error('incomplete profile reproduction');
const variants={baseline:original.variants.baseline,'fuse-small':original.variants['fuse-small'],
 'byte-slices':{ids:['VM-05'],artifacts:original.variants.baseline.artifacts},
 'byte-slices-fused':{ids:['VM-05','VM-10'],artifacts:original.variants['fuse-small'].artifacts}};
for(const variant of Object.values(variants))for(const item of Object.values(variant.artifacts))
 if(sha(item.path)!==item.sha256)throw Error('guest artifact changed');
const native=artifact(resolve('.scratch/common-memory-php-shared-build-1/out/php-fpm.wasm'));
const hostProfiles=Object.fromEntries(Object.keys(variants).map(mode=>[mode,mode.startsWith('byte-')?candidateProfile:baselineProfile]));
const profileArtifacts={};
for(const profile of new Set(Object.values(hostProfiles)))
 profileArtifacts[profile]=Object.fromEntries(readdirSync(profile).map(name=>[name,artifact(resolve(profile,name))]));
const manifest={scope:'VM-05 private host-profile change only; own-profile ordinary controls; same PHP/helper O2 and exact guest modules',
 variants,hostProfiles,profileArtifacts,defaultProfileReproduced:reproduction,
 nativeArtifacts:Object.fromEntries(Object.keys(variants).map(mode=>[mode,native])),
 pairReferences:{'byte-slices':'baseline','byte-slices-fused':'fuse-small'},
 guardHelper:original.guardHelper,profileInputs:candidateInputs};
writeFileSync(resolve(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({output,modes:Object.keys(variants),defaultBundlesReproduced:6}));
