// Bounded WordPress compiler screen. VM modes run in opposite orders, with
// each actual PHP compiler build bracketed by its own ordinary FILE parents.
export function wordpressCompilerPlan(m) {
  const modes=['baseline','helper-o3','php-c-o3','both-o3','php-lto-full','php-lto-thin',
    'fuse-small','both-o3-fused','php-lto-full-fused','php-lto-thin-fused'];
  const ordinary=['baseline','php-c-o3','php-lto-full','php-lto-thin'];
  const group=mode=>mode.startsWith('php-lto-full')?'php-lto-full':
    mode.startsWith('php-lto-thin')?'php-lto-thin':
    mode==='php-c-o3'||mode.startsWith('both-o3')?'php-c-o3':'baseline';
  if(Object.keys(m.variants??{}).length!==modes.length||modes.some(mode=>
    !m.variants[mode]?.artifacts?.fpm||!m.nativeArtifacts?.[mode]))throw Error('incomplete compiler screen');
  const profile=m.hostProfiles?.baseline;
  if(!profile||modes.some(mode=>m.hostProfiles?.[mode]!==profile))throw Error('compiler screen must hold host profile constant');
  for(const mode of modes) {
    if(m.appOptions?.[mode]?.validateTimestamps!==false||Object.hasOwn(m.appOptions[mode],'preloadPaths'))
      throw Error('compiler screen requires immutable timestamps and unchanged preload behavior');
    const reference=m.nativeArtifacts[group(mode)],candidate=m.nativeArtifacts[mode];
    if(candidate.path!==reference.path||candidate.sha256!==reference.sha256||candidate.bytes!==reference.bytes)
      throw Error('compiler mode must use its own ordinary PHP build: '+mode);
  }
  if(new Set(ordinary.map(mode=>m.nativeArtifacts[mode].sha256)).size!==ordinary.length)
    throw Error('distinct compiler controls unexpectedly identical');
  const row=(mode,label,cohort,order)=>({mode,label,cohort,block:0,order,seed:6197+cohort,
    protocol:'wordpress-compiler-shared-v1',ordinaryGroup:group(mode),
    ordinaryComparison:'own-php-build-file-cache-reference'});
  return [...ordinary.map((mode,i)=>row(mode,'native-file',0,i)),
    ...modes.map((mode,i)=>row(mode,'vm-shared',0,i+ordinary.length)),
    ...[...modes].reverse().map((mode,i)=>row(mode,'vm-shared',1,i)),
    ...[...ordinary].reverse().map((mode,i)=>row(mode,'native-file',1,i+modes.length))];
}
