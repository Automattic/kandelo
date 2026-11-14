import {readFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {pairedPlan} from './paired-plan.mjs';
import {freezeInputs,hostProfileFor} from './paired-inputs.mjs';
import {wordpressHash} from './wordpress-inputs.mjs';
import {validatePreloadPaths} from './wordpress-preload-config.mjs';

// Separate from the historical cache-major protocol. Every case has its own
// ordinary compiler/profile/settings control, including application factors.
export function wordpressPairedInputs(variants,profile,image,native,manifest,settings) {
  if(!manifest.nativeArtifacts)throw Error('WordPress pairs require own ordinary controls');
  if(!['sqlite','mariadb'].includes(settings.backend)||!Number.isSafeInteger(settings.warmup)||settings.warmup<0||
     !Number.isSafeInteger(settings.rounds)||settings.rounds<1)throw Error('invalid WordPress collection settings');
  const plan=pairedPlan(manifest).map(t=>({...t,protocol:'wordpress-matched-cases-v1'}));
  const modes=[...new Set(plan.map(t=>t.mode))],appOptions={},hostProfiles={};
  if(manifest.appOptions!==undefined&&(!manifest.appOptions||typeof manifest.appOptions!=='object'||
    Array.isArray(manifest.appOptions)||Object.keys(manifest.appOptions).length!==modes.length||
    modes.some(m=>!Object.hasOwn(manifest.appOptions,m))))throw Error('incomplete app option bindings');
  for(const mode of modes) {
    const declared=manifest.appOptions?.[mode]??{};
    if(!declared||typeof declared!=='object'||Array.isArray(declared)||
       Object.keys(declared).some(k=>!['validateTimestamps','preloadPaths'].includes(k)))throw Error(`unsupported WordPress app options: ${mode}`);
    const validateTimestamps=Object.hasOwn(declared,'validateTimestamps')?declared.validateTimestamps:true;
    if(typeof validateTimestamps!=='boolean')throw Error(`invalid timestamp option: ${mode}`);
    appOptions[mode]={validateTimestamps};
    if(Object.hasOwn(declared,'preloadPaths'))appOptions[mode].preloadPaths=validatePreloadPaths(declared.preloadPaths);
    hostProfiles[mode]=hostProfileFor(manifest,mode,profile);
  }
  const inputs=freezeInputs(variants,profile,manifest,native);
  for(const path of [image,resolve('apps/browser-demos/lib/init/wordpress-runtime-config.ts'),
    resolve('apps/browser-demos/lib/init/php-fpm-worker-count.ts')])inputs[path]=wordpressHash(path);
  const expectedArtifacts={native:{},vm:{}};
  for(const mode of modes)for(const kind of ['native','vm']) {
    const artifact=kind==='native'?manifest.nativeArtifacts[mode]:manifest.variants[mode].artifacts.fpm;
    if(inputs[artifact.path]!==artifact.sha256||statSync(artifact.path).size!==artifact.bytes)
      throw Error(`WordPress artifact differs from manifest: ${mode} ${kind}`);
    expectedArtifacts[kind][mode]=artifact.sha256;
  }
  return {schema:1,inputs,plan,settings,appOptions,hostProfiles,expectedArtifacts,
    imageSha256:inputs[image],kernelSha256:inputs['local-binaries/source-only-v1/kernel.wasm']};
}

export function wordpressPairedEnvironment(frozen,mode) {
  return {KANDELO_SURVEY_WARMUP:String(frozen.settings.warmup),KANDELO_SURVEY_ROUNDS:String(frozen.settings.rounds),
    KANDELO_SURVEY_VALIDATE_TIMESTAMPS:frozen.appOptions[mode].validateTimestamps?'1':'0',
    KANDELO_SURVEY_CHECK_TIMESTAMP_POLICY:'0',KANDELO_SURVEY_PROBES:'0',
    ...(Object.hasOwn(frozen.appOptions[mode],'preloadPaths')?{KANDELO_SURVEY_PRELOAD_PATHS:JSON.stringify(frozen.appOptions[mode].preloadPaths)}:{})};
}

export function readWordpressPairedInputs(variants) {
  return JSON.parse(readFileSync(resolve(variants,'manifest.json')));
}
