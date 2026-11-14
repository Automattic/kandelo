import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
export function hostProfileFor(manifest,mode,fallback) {
  const path=manifest.hostProfiles?manifest.hostProfiles[mode]:fallback;
  if(typeof path!=='string'||!path)throw Error(`missing host profile: ${mode}`);
  return resolve(path);
}
export function hostProfileBindings(manifest,fallback) {
  return manifest.hostProfiles?Object.fromEntries(Object.keys(manifest.variants).map(mode=>[mode,hostProfileFor(manifest,mode,fallback)])):undefined;
}
export function freezeInputs(variants,profile,manifest,native) {
  const profiles=new Set([resolve(profile),...Object.values(hostProfileBindings(manifest,profile)??{})]);
  for(const folder of profiles) {
    const settings=JSON.parse(readFileSync(resolve(folder,'profile-inputs.json'),'utf8'));
    if(['accessDiagnostics','syscallDiagnostics','workerProfileDiagnostics','byteSliceDiagnostics','metadataDiagnostics'].some(key=>settings[key]))
      throw Error('diagnostic host profile cannot enter plain timing');
  }
  const files=[resolve(variants,'manifest.json'),native,'local-binaries/source-only-v1/kernel.wasm',
    'local-binaries/partial/shell-partial.vfs.zst','tools/common-memory-program/helpers.c',
    ...readdirSync('tools/common-memory-program/instrument/src').filter(p=>p.endsWith('.rs'))
      .map(p=>resolve('tools/common-memory-program/instrument/src',p)),
    'tools/common-memory-program/instrument/Cargo.lock',
    ...Object.values(manifest.variants).map(v=>v.artifacts.fpm.path),
    ...Object.values(manifest.nativeArtifacts??{}).map(a=>a.path),
    ...[...profiles].flatMap(folder=>readdirSync(folder).map(p=>resolve(folder,p))),
    ...['platform','survey'].flatMap(dir=>readdirSync(`tools/common-memory-program/${dir}`)
      .filter(p=>/\.(mjs|ts|py|c|wat)$/.test(p)).map(p=>resolve('tools/common-memory-program',dir,p)))];
  const frozen=Object.fromEntries(files.map(p=>[p,hash(p)]));
  if(manifest.hostProfiles)for(const folder of profiles) {
    const declared=manifest.profileArtifacts?.[folder];
    if(!declared||Object.keys(declared).length!==readdirSync(folder).length)throw Error('missing host profile artifact inventory');
    for(const [name,artifact] of Object.entries(declared))if(artifact.path!==resolve(folder,name)||frozen[artifact.path]!==artifact.sha256)
      throw Error('host profile artifact does not match manifest: '+name);
  }
  return frozen;
}
export function verifyInputs(inputs) {for(const [p,digest] of Object.entries(inputs))if(hash(p)!==digest)throw Error(`input changed: ${p}`);}
