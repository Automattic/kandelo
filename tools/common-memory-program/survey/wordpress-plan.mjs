// Cache-major order places the reference beside its candidate for a two-mode
// screen. Reverse the middle in cohort2; every control has a fresh parent.
export function wordpressPlan(modes) {
  if(!modes.length || modes[0]!=='baseline' || new Set(modes).size!==modes.length)
    throw Error('unique candidate list must start with baseline');
  const controls=['vm-file','vm-shared'].flatMap(label=>modes.map(mode=>({mode,label})));
  return [controls,[...controls].reverse()].flatMap((middle,cohort)=>
    [{mode:'baseline',label:'native-file'},...middle,{mode:'baseline',label:'native-file'}]
      .map((trial,order)=>({...trial,protocol:'cache-major-v2',cohort,order,seed:6197+cohort})));
}
