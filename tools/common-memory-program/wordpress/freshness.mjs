// Both host adapters expose these worker-owned VFS and HTTP capabilities.
// No OPcache invalidation API or timestamp-check bypass is used here.
export async function checkFreshness(host) {
  const path='/srv/www/html/common-memory-freshness.php';
  const source=value=>`<?php
require __DIR__.'/wp-load.php';
header('Content-Type: application/json');
header('Cache-Control: no-store');
echo json_encode(array('value'=>'${value}','pid'=>getmypid(),
 'validate_timestamps'=>ini_get('opcache.validate_timestamps'),
 'revalidate_freq'=>ini_get('opcache.revalidate_freq'),
 'cached'=>opcache_is_script_cached(__FILE__),'mtime'=>filemtime(__FILE__)));
`;
  const read=async()=>{
    const r=await host.fetchInKernel(8080,{method:'GET',url:'/common-memory-freshness.php',headers:{Host:'localhost'},body:null},{timeoutMs:120000});
    if(r.status!==200)throw Error(`freshness HTTP ${r.status}: ${new TextDecoder().decode(r.body).slice(0,1024)}`);
    return JSON.parse(new TextDecoder().decode(r.body));
  };
  const check=(rows,value)=>{
    for(const r of rows)if(r.value!==value||r.validate_timestamps!=='1'||r.revalidate_freq!=='0')
      throw Error('freshness/configuration mismatch: '+JSON.stringify(r));
    if(new Set(rows.map(r=>r.pid)).size!==2)throw Error('freshness did not exercise both FPM workers');
    if(!rows.some(r=>r.cached===true))throw Error('freshness source was never observed in OPcache');
  };
  await host.writeFileToVfs(path,new TextEncoder().encode(source('before-edit')),0o644);
  const before=await Promise.all(Array.from({length:8},read));check(before,'before-edit');
  // PHP compares second-resolution mtime. Wait across that real boundary,
  // rather than mutating metadata or explicitly invalidating the cache.
  const nextSecond=(Math.max(...before.map(r=>r.mtime))+1)*1000;
  const remaining=nextSecond-Date.now()+20;
  if(remaining>2000)throw Error('guest and host clocks disagree at freshness boundary');
  if(remaining>0)await new Promise(resolve=>setTimeout(resolve,remaining));
  await host.writeFileToVfs(path,new TextEncoder().encode(source('after-source-edit')),0o644);
  const after=await Promise.all(Array.from({length:8},read));check(after,'after-source-edit');
  if(after.some(r=>r.mtime<=Math.max(...before.map(r=>r.mtime))))throw Error('source mtime did not advance');
  return {passed:true,before,after};
}
