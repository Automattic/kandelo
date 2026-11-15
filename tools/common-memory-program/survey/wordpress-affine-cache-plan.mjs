// Bounded first screen: fresh parents, reversed VM order, common ordinary
// brackets. All four modes use the same compiler and timestamp policy.
export function wordpressAffineCachePlan(manifest) {
  const modes=['baseline','small','affine','affine-small'];
  if(modes.some(m=>!manifest.variants?.[m]||!manifest.nativeArtifacts?.[m]))throw Error('four affine-cache modes required');
  const ordinary=manifest.nativeArtifacts.baseline.sha256;
  if(modes.some(m=>manifest.nativeArtifacts[m].sha256!==ordinary))throw Error('common ordinary brackets require identical builds');
  const row=(mode,label,cohort,order)=>({mode,label,cohort,block:0,order,seed:6197+cohort,
    protocol:'wordpress-affine-cache-shared-v1',candidate:mode==='small'||mode==='affine-small'?'affine-small':'affine',
    reference:mode==='small'||mode==='affine-small'?'small':'baseline'});
  return [row('baseline','native-file',0,0),...modes.map((m,i)=>row(m,'vm-shared',0,i+1)),
    ...[...modes].reverse().map((m,i)=>row(m,'vm-shared',1,i)),row('baseline','native-file',1,4)];
}
