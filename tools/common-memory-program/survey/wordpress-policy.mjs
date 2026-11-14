// APP-02 correctness diagnostic, run after all timed WordPress requests.
// The controller is blacklisted; the included target is an ordinary cached
// PHP file created and edited by the guest, with distinct past mtimes.
const encode=s=>new TextEncoder().encode(s);
const must=(condition,message)=>{if(!condition)throw Error(message);};
const controller='/srv/www/html/common-memory-policy.php';
const target='/tmp/common-memory-policy-target.php';
const phpString=s=>"'"+s.replaceAll('\\','\\\\').replaceAll("'","\\'")+"'";

export function timestampOptionsFromEnv(env) {
  for(const key of ['KANDELO_SURVEY_VALIDATE_TIMESTAMPS','KANDELO_SURVEY_CHECK_TIMESTAMP_POLICY'])
    must(env[key]===undefined||['0','1'].includes(env[key]),`invalid ${key}`);
  return {validateTimestamps:env.KANDELO_SURVEY_VALIDATE_TIMESTAMPS!=='0',
    checkTimestampPolicy:env.KANDELO_SURVEY_CHECK_TIMESTAMP_POLICY==='1'};
}

export async function installTimestampProbe(host) {
  const source=version=>`<?php return ['version'=>${version}, 'pid'=>getmypid()];`;
  await host.writeFileToVfs(controller,encode(`<?php
header('Content-Type: application/json');
header('Cache-Control: no-store');
$file=${phpString(target)};
$action=$_GET['action'] ?? 'read';
$out=['action'=>$action, 'pid'=>getmypid(),
  'validate_timestamps'=>ini_get('opcache.validate_timestamps'),
  'revalidate_freq'=>ini_get('opcache.revalidate_freq')];
$disk=ini_get('opcache.file_cache');
if ($action === 'prepare' || $action === 'edit') {
  $code=$action === 'prepare' ? ${phpString(source(1))} : ${phpString(source(2))};
  $stamp=$action === 'prepare' ? 1600000000 : 1600000060;
  $out['written']=file_put_contents($file,$code);
  $out['touched']=touch($file,$stamp);
} elseif ($action === 'invalidate') {
  $out['invalidated']=opcache_invalidate($file,true);
} elseif ($action === 'clear-file-cache' && $disk !== '') {
  // This exact diagnostic target only; never clear WordPress's cache corpus.
  $out['removed']=[];
  foreach (glob($disk.'/*'.$file.'.bin') as $path) {
    $out['removed'][]=['path'=>$path, 'unlinked'=>unlink($path)];
  }
} elseif ($action === 'read') {
  $out['payload']=include $file;
  $out['cached']=opcache_is_script_cached($file);
} else { http_response_code(400); }
clearstatcache(true,$file);
$out['mtime']=filemtime($file);
$out['disk_cache_files']=$disk === '' ? [] : glob($disk.'/*'.$file.'.bin');
echo json_encode($out);
`));
  const path='/etc/php-opcache-blacklist.txt';
  const previous=new TextDecoder().decode(await host.readFileFromVfs(path));
  await host.writeFileToVfs(path,encode(previous+'\n'+controller+'\n'));
}

export async function timestampProbe(request,validateTimestamps,shared,result) {
  const call=async action=>{
    const response=await request(`/common-memory-policy.php?action=${action}`);
    must(response.status===200,`policy ${action}: HTTP ${response.status}: ${response.text.slice(0,200)}`);
    const value=JSON.parse(response.text);
    must(value.action===action&&value.validate_timestamps===(validateTimestamps?'1':'0')&&value.revalidate_freq==='0','wrong effective timestamp policy');
    return value;
  };
  const both=async (name,version)=>{
    const values=result[name]=[];
    for(let attempt=0;attempt<4;attempt++) {
      values.push(...await Promise.all(Array.from({length:8},()=>call('read'))));
      if(new Set(values.map(v=>v.pid)).size===2)break;
    }
    must(new Set(values.map(v=>v.pid)).size===2,`policy ${name}: both FPM workers must answer`);
    must(values.every(v=>v.payload?.version===version&&v.payload?.pid===v.pid),`policy ${name}: wrong cached program version`);
    if(shared)must(values.some(v=>v.cached),'policy target was not cached');
  };
  result.prepare=await call('prepare');
  must(result.prepare.written>0&&result.prepare.touched&&result.prepare.mtime===1600000000,'policy target preparation failed');
  await both('initial',1);
  if(!shared)must(result.initial.some(v=>v.disk_cache_files.length>0),'policy target has no disk cache entry');
  result.edit=await call('edit');
  must(result.edit.written>0&&result.edit.touched&&result.edit.mtime===1600000060,'policy target edit failed');
  await both('afterEdit',validateTimestamps?2:1);
  result.invalidate=await call('invalidate');
  if(shared)must(result.invalidate.invalidated,'explicit shared cache invalidation failed');
  else {
    // PHP's file-cache-only request startup disables accelerator_enabled;
    // zend_accel_invalidate consequently returns FAILURE before disk removal.
    // Observe that boundary and test explicit removal as a separate operation.
    must(result.invalidate.invalidated===false,'unexpected file-cache-only invalidation result');
    result.fileCacheRemoval=await call('clear-file-cache');
    must(result.fileCacheRemoval.removed.length>0&&result.fileCacheRemoval.removed.every(v=>v.unlinked)&&result.fileCacheRemoval.disk_cache_files.length===0,'explicit target disk-cache removal failed');
  }
  await both('afterInvalidation',2);
  result.passed=true;
}
