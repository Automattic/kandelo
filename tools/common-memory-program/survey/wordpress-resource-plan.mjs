// A bounded resource study, not a latency screen or full process retirement
// proof. Existing watchdogs, memory ceilings and application assertions stay.
export function wordpressResourcePlan(m) {
  const modes=['ordinary','control','reuse'];
  if(Object.keys(m.variants??{}).length!==3||modes.some(mode=>!m.variants[mode]?.artifacts?.fpm||!m.nativeArtifacts?.[mode]))
    throw Error('resource study requires ordinary/control/reuse bindings');
  if(m.resourceSettings?.warmup!==2||m.resourceSettings?.rounds!==128)
    throw Error('resource study must retain its declared 128-round workload');
  if(!m.hostProfiles?.control||m.hostProfiles.ordinary!==m.hostProfiles.control||
    !m.hostProfiles.reuse||m.hostProfiles.reuse===m.hostProfiles.control)
    throw Error('resource study needs distinct reuse and matched ordinary/control profiles');
  for(const mode of modes) {
    if(m.appOptions?.[mode]?.validateTimestamps!==false||Object.hasOwn(m.appOptions[mode],'preloadPaths'))
      throw Error('resource study requires the same immutable-code/non-preload policy');
    for(const key of ['path','bytes','sha256']) {
      if(m.variants[mode].artifacts.fpm[key]!==m.variants.control.artifacts.fpm[key])
        throw Error('reuse study must hold VM guest artifact constant');
      if(m.nativeArtifacts[mode][key]!==m.nativeArtifacts.control[key])
        throw Error('resource study must hold ordinary PHP build constant');
    }
  }
  return modes.map((mode,order)=>({mode,label:mode==='ordinary'?'native-file':'vm-shared',
    cohort:0,block:0,order,seed:6197,protocol:'wordpress-resource-lifetime-v1',
    scope:'128-round fixed-pool allocation study, no latency ranking/RSS/process-retirement claim'}));
}
