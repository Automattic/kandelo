// VM-05/VM-10 first WordPress latency screen. Ordinary brackets must use
// each host profile even when their untranslated guest artifacts are equal.
export function wordpressBytePlan(manifest) {
  const modes=['baseline','byte-slices','fuse-small','byte-slices-fused'];
  if(modes.some(m=>!manifest.variants?.[m]||!manifest.nativeArtifacts?.[m]||!manifest.hostProfiles?.[m]))
    throw Error('byte screen needs all four modes and own host/ordinary bindings');
  for(const [a,b] of [['baseline','fuse-small'],['byte-slices','byte-slices-fused']])
    if(manifest.hostProfiles[a]!==manifest.hostProfiles[b]||manifest.nativeArtifacts[a].sha256!==manifest.nativeArtifacts[b].sha256)
      throw Error('shared ordinary bracket has mismatched profile/artifact');
  if(manifest.hostProfiles.baseline===manifest.hostProfiles['byte-slices'])throw Error('candidate host profile must differ');
  for(const [a,b] of [['byte-slices','baseline'],['byte-slices-fused','fuse-small']])
    if(manifest.variants[a].artifacts.fpm.sha256!==manifest.variants[b].artifacts.fpm.sha256)
      throw Error('byte-only pair must use identical guest artifacts');
  const row=(mode,label,cohort,order)=>({mode,label,cohort,block:0,order,seed:6197+cohort,
    protocol:'wordpress-byte-small-shared-v1',
    candidate:mode==='fuse-small'||mode==='byte-slices-fused'?'byte-slices-fused':'byte-slices',
    reference:mode==='fuse-small'||mode==='byte-slices-fused'?'fuse-small':'baseline'});
  return [row('baseline','native-file',0,0),row('byte-slices','native-file',0,1),
    ...modes.map((m,i)=>row(m,'vm-shared',0,i+2)),
    ...[...modes].reverse().map((m,i)=>row(m,'vm-shared',1,i)),
    row('byte-slices','native-file',1,4),row('baseline','native-file',1,5)];
}
