// Preload effects have matched shared-cache VM controls. Ordinary file-cache
// brackets are profile-matched but explicitly NOT preload-equivalent.
export function wordpressPreloadPlan(m) {
 const modes=['baseline','preload','preset','preset-preload'];
 if(modes.some(k=>!m.variants?.[k]||!m.nativeArtifacts?.[k]||!m.hostProfiles?.[k]))throw Error('incomplete preload factorial');
 for(const[a,b]of[['baseline','preload'],['preset','preset-preload']]){
  if(m.hostProfiles[a]!==m.hostProfiles[b]||m.variants[a].artifacts.fpm.sha256!==m.variants[b].artifacts.fpm.sha256||m.nativeArtifacts[a].sha256!==m.nativeArtifacts[b].sha256)throw Error('preload pair must preserve compiler/profile/ordinary artifact');
  if(m.appOptions?.[a]?.preloadPaths!==null||!Array.isArray(m.appOptions?.[b]?.preloadPaths)||!m.appOptions[b].preloadPaths.length)throw Error('explicit off/on preload bindings required');
 }
 if(modes.some(k=>m.appOptions[k].validateTimestamps!==false))throw Error('preload experiment requires immutable timestamps off');
 const row=(mode,label,cohort,order)=>({mode,label,cohort,block:0,order,seed:6197+cohort,protocol:'wordpress-preload-preset-shared-v1',
  candidate:mode.startsWith('preset')?'preset-preload':'preload',reference:mode.startsWith('preset')?'preset':'baseline',
  ordinaryComparison:'unpreloaded-file-cache-reference'});
 return[row('baseline','native-file',0,0),row('preset','native-file',0,1),...modes.map((k,i)=>row(k,'vm-shared',0,i+2)),
  ...[...modes].reverse().map((k,i)=>row(k,'vm-shared',1,i)),row('preset','native-file',1,4),row('baseline','native-file',1,5)];
}
