// Bounded CC03/VM10 first application screen. Each VM configuration has two
// independent parents in opposite order; both ordinary compiler builds have
// opening/closing parents. Shared OPcache only: no pure translation-tax claim.
export function wordpressFactorialPlan(manifest) {
 const modes=['baseline','php-pgo','fuse-small','php-pgo-fused'];
 if(modes.some(mode=>!manifest.variants?.[mode]||!manifest.nativeArtifacts?.[mode]))throw Error('factorial screen requires all four compiler/fusion variants and own ordinary controls');
 const row=(mode,label,cohort,order)=>({mode,label,cohort,block:0,order,seed:6197+cohort,
  protocol:'wordpress-pgo-small-factorial-shared-v1',
  candidate:mode==='fuse-small'||mode==='php-pgo-fused'?'php-pgo-fused':'php-pgo',
  reference:mode==='fuse-small'||mode==='php-pgo-fused'?'fuse-small':'baseline'});
 const before=[row('baseline','native-file',0,0),row('php-pgo','native-file',0,1)];
 const first=modes.map((mode,i)=>row(mode,'vm-shared',0,i+2));
 const second=[...modes].reverse().map((mode,i)=>row(mode,'vm-shared',1,i));
 const after=[row('php-pgo','native-file',1,4),row('baseline','native-file',1,5)];
 return[...before,...first,...second,...after];
}
