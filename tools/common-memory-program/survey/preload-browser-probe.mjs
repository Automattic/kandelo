// Browser counterpart of the Node first-pass preload probe. All methods stay
// on the normal host proxy; only copied bytes/JSON cross to this page.
export function installBrowserPreloadProbe(Host,{paths,preload,warmup=1,rounds=1}) {
 const report={mode:preload?'compile-preload':'inventory',paths,passed:false};
 const write=Host.prototype.writeFileToVfs,stats=Host.prototype.commonMemoryPrototypeStats,fetch=Host.prototype.fetchInKernel;
 const encode=s=>new TextEncoder().encode(s),decode=b=>new TextDecoder().decode(b);
 const encoded=btoa(Array.from(encode(JSON.stringify(paths)),b=>String.fromCharCode(b)).join(''));
 const script=`<?php $paths=json_decode(base64_decode('${encoded}'),true); $ok=0;$failed=[];foreach($paths as $path){if(opcache_compile_file($path))$ok++;else $failed[]=$path;}file_put_contents('/tmp/common-memory-preload-complete.json',json_encode(['requested'=>count($paths),'compiled'=>$ok,'failed'=>$failed]));`;
 Host.prototype.writeFileToVfs=async function(path,data,...args){
  if(path==='/usr/sbin/php-fpm')await write.call(this,'/srv/www/html/common-memory-cache-inventory.php',encode(`<?php header('Content-Type: application/json');$s=opcache_get_status(true);echo json_encode(['cachedScripts'=>array_values(array_filter(array_keys($s['scripts']??[]),fn($p)=>str_starts_with($p,'/srv/www/html/')&&!str_contains($p,'common-memory-'))),'statistics'=>$s['opcache_statistics']??null,'memory'=>$s['memory_usage']??null,'preload'=>$s['preload_statistics']??null]);`),0o644);
  if(path==='/etc/php.ini'&&preload){const passwd=decode(await this.readFileFromVfs('/etc/passwd'));if(!/^nobody:/m.test(passwd))throw Error('missing FPM nobody user');await write.call(this,'/tmp/common-memory-preload.php',encode(script),0o644);report.appliedIni=decode(data)+'\nopcache.preload=/tmp/common-memory-preload.php\nopcache.preload_user=nobody\n';data=encode(report.appliedIni);}
  return write.call(this,path,data,...args);
 };
 Host.prototype.fetchInKernel=async function(...args){const response=await fetch.apply(this,args);if(preload&&response.status>=500){const bytes=await this.readFileFromVfs('/var/log/php-fpm.log');if(bytes&&/fatal(?: error)?|ERROR:/i.test(decode(bytes)))throw Error('preload startup failure; see PHP log');}return response;};
 let phase=0;
 Host.prototype.commonMemoryPrototypeStats=async function(...args){const value=await stats.apply(this,args);if(phase++===warmup+rounds){const response=await this.fetchInKernel(8080,{method:'GET',url:'/common-memory-cache-inventory.php',headers:{Host:'localhost'},body:null},{timeoutMs:15000,maxResponseBytes:2*1024*1024});if(response.status!==200)throw Error('inventory request failed');report.inventory=JSON.parse(decode(response.body));if(preload){const bytes=await this.readFileFromVfs('/tmp/common-memory-preload-complete.json');if(bytes)report.completion=JSON.parse(decode(bytes));}}return value;};
 return{report,restore(){Host.prototype.writeFileToVfs=write;Host.prototype.commonMemoryPrototypeStats=stats;Host.prototype.fetchInKernel=fetch;}};
}
