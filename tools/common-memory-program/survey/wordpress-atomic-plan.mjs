// VM06/VM10 application screen. All four guests have one ordinary compiler,
// host profile and application policy, so a common opening/closing ordinary
// bracket is valid. These shared/file references include OPcache effects.
export function wordpressAtomicPlan(m) {
  const modes=['baseline','atomics','small','combined'];
  if(Object.keys(m.variants??{}).length!==modes.length||modes.some(mode=>
    !m.variants[mode]?.artifacts?.fpm||!m.nativeArtifacts?.[mode]))throw Error('atomic screen needs exactly four configurations');
  const profile=m.hostProfiles?.baseline,ordinary=m.nativeArtifacts.baseline;
  if(!profile||modes.some(mode=>m.hostProfiles?.[mode]!==profile))throw Error('atomic screen must hold host profile constant');
  for(const mode of modes) {
    const a=m.nativeArtifacts[mode];
    if(a.path!==ordinary.path||a.sha256!==ordinary.sha256||a.bytes!==ordinary.bytes)
      throw Error('atomic configurations must share the same ordinary compiler artifact');
    if(m.appOptions?.[mode]?.validateTimestamps!==false||Object.hasOwn(m.appOptions[mode],'preloadPaths'))
      throw Error('atomic screen requires immutable timestamps and unchanged preload behavior');
  }
  if(new Set(modes.map(mode=>m.variants[mode].artifacts.fpm.sha256)).size!==modes.length)
    throw Error('atomic configurations unexpectedly have identical guests');
  const row=(mode,label,cohort,order)=>({mode,label,cohort,block:0,order,seed:6197+cohort,
    protocol:'wordpress-atomic-small-shared-v1',ordinaryGroup:'baseline',
    candidate:mode==='small'||mode==='combined'?'combined':'atomics',
    reference:mode==='small'||mode==='combined'?'small':'baseline',
    ordinaryComparison:'common-identical-php-profile-file-bracket'});
  return [row('baseline','native-file',0,0),
    ...modes.map((mode,i)=>row(mode,'vm-shared',0,i+1)),
    ...[...modes].reverse().map((mode,i)=>row(mode,'vm-shared',1,i)),
    row('baseline','native-file',1,modes.length)];
}
