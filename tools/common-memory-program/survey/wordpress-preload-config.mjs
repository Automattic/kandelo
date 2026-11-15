// Explicit APP01 fixture configuration; no prototype hooks or timed counters.
const encode=s=>new TextEncoder().encode(s),decode=b=>new TextDecoder().decode(b);
const must=(v,n)=>{if(!v)throw Error(n);};
const controller='/srv/www/html/common-memory-preload-state.php';
const marker='/tmp/common-memory-preload-complete.json';
export function validatePreloadPaths(paths) {
 if(paths===null)return null;
 must(Array.isArray(paths)&&paths.length>0&&new Set(paths).size===paths.length&&
  paths.every(p=>typeof p==='string'&&/^\/srv\/www\/html\/[^\0\r\n]*\.php$/.test(p)&&!p.split('/').includes('..')),'invalid preload paths');
 return paths;
}
export function preloadOptionsFromEnv(env) {
 if(env.KANDELO_SURVEY_PRELOAD_PATHS===undefined)return{};
 return{preloadPaths:validatePreloadPaths(JSON.parse(env.KANDELO_SURVEY_PRELOAD_PATHS))};
}
export async function prepareWordPressPreload(host,ini,paths,shared) {
 validatePreloadPaths(paths);must(paths===null||shared,'preload requires shared OPcache; ordinary file mode is a separate reference');
 must(!/^\s*opcache\.preload\s*=/m.test(ini),'fixture already declares preload');
 await host.writeFileToVfs(controller,encode(`<?php header('Content-Type: application/json');$s=opcache_get_status(false);$p=$s['preload_statistics']??null;echo json_encode(['pid'=>getmypid(),'file_cache_only'=>ini_get('opcache.file_cache_only'),'function'=>function_exists('absint'),'class'=>class_exists('WP_Error',false),'preload'=>$p?['functions'=>count($p['functions']??[]),'classes'=>count($p['classes']??[]),'scripts'=>count($p['scripts']??[]),'memory'=>$p['memory_consumption']??null]:null]);`),0o644);
 if(paths!==null){
  const passwd=decode(await host.readFileFromVfs('/etc/passwd'));must(/^nobody:/m.test(passwd),'missing normal FPM nobody user');
  const encoded=btoa(Array.from(encode(JSON.stringify(paths)),b=>String.fromCharCode(b)).join(''));
  const script=`<?php $paths=json_decode(base64_decode('${encoded}'),true);$ok=0;$failed=[];foreach($paths as $path){if(opcache_compile_file($path))$ok++;else $failed[]=$path;}file_put_contents('${marker}',json_encode(['requested'=>count($paths),'compiled'=>$ok,'failed'=>$failed]));`;
  await host.writeFileToVfs('/tmp/common-memory-preload.php',encode(script),0o644);
  ini+='\nopcache.preload=/tmp/common-memory-preload.php\nopcache.preload_user=nobody\n';
 }
 return ini;
}
export async function verifyWordPressPreload(host,request,paths,shared,result) {
 const requests=result.requests=[];
 for(let attempt=0;attempt<4;attempt++){
  const values=await Promise.all(Array.from({length:8},(_,i)=>request('/common-memory-preload-state.php?probe='+i)));
  for(const r of values){must(r.status===200,'preload state request failed');requests.push(JSON.parse(r.text));}
  if(new Set(requests.map(r=>r.pid)).size===2)break;
 }
 must(new Set(requests.map(r=>r.pid)).size===2,'preload state must observe both workers');
 const bytes=await host.readFileFromVfs(marker);result.completion=bytes?JSON.parse(decode(bytes)):null;
 for(const r of requests){
  must(r.file_cache_only===(shared?'0':'1'),'preload verifier cache mode');
  if(paths===null)must(!r.function&&!r.class&&r.preload===null&&result.completion===null,'unpreloaded control acquired preload state');
  else must(r.function&&r.class&&r.preload?.scripts>=paths.length&&r.preload.functions>0&&r.preload.classes>0,'preloaded definitions/statistics missing');
 }
 if(paths!==null)must(result.completion?.requested===paths.length&&result.completion.compiled===paths.length&&result.completion.failed.length===0,'preload inventory did not compile completely');
 result.passed=true;
}
