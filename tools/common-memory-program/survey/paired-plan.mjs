export function pairedPlan(manifest) {
  const references=manifest.pairReferences;
  if(!references||!Object.keys(references).length)throw Error('explicit candidate/reference pairs required');
  for(const [candidate,reference] of Object.entries(references))
    if(candidate===reference||!manifest.variants[candidate]||!manifest.variants[reference])throw Error('invalid pair');
  const matchedNative=!!manifest.nativeArtifacts;
  if(manifest.hostProfiles) {
    if(!matchedNative)throw Error('per-mode host profiles require matched ordinary brackets');
    for(const mode of Object.keys(manifest.variants))if(typeof manifest.hostProfiles[mode]!=='string'||!manifest.hostProfiles[mode])
      throw Error(`missing host profile: ${mode}`);
  }
  if(matchedNative)for(const mode of new Set(Object.entries(references).flat())) {
    const artifact=manifest.nativeArtifacts[mode];
    if(!artifact?.path||!/^([0-9a-f]{64})$/.test(artifact.sha256)||!Number.isSafeInteger(artifact.bytes)||artifact.bytes<=0)
      throw Error(`missing matched ordinary artifact: ${mode}`);
  }
  return [0,1].flatMap(cohort=>{
    const candidates=Object.keys(references);if(cohort)candidates.reverse();
    return candidates.flatMap((candidate,block)=>{
      const reference=references[candidate];
      const middle=cohort?
        [[candidate,'vm-shared'],[reference,'vm-shared'],[candidate,'vm-file'],[reference,'vm-file']]:
        [[reference,'vm-file'],[candidate,'vm-file'],[reference,'vm-shared'],[candidate,'vm-shared']];
      const before=matchedNative?(cohort?[[candidate,'native-file'],[reference,'native-file']]:[[reference,'native-file'],[candidate,'native-file']]):[['baseline','native-file']];
      return [...before,...middle,...[...before].reverse()]
        .map(([mode,label],order)=>({candidate,reference,cohort,block,order,mode,label,seed:6197+cohort,
          ...(matchedNative?{protocol:'matched-native-builds-v1'}:{})}));
    });
  });
}
