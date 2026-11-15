// APP01 first pass: train a compile-only preload inventory on the existing
// mixed-page fixture, then exercise the same app with native PHP preloading.
// Capture diagnostics separately; never pool this with plain timing matrices.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [profile,,,out]=process.argv.slice(2);if(existsSync(out))throw Error('fresh preload output required');mkdirSync(out,{recursive:true});
const inventoryPath=process.env.KANDELO_PRELOAD_INVENTORY;
const paths=inventoryPath?JSON.parse(readFileSync(inventoryPath)).cachedScripts:[];
if(!Array.isArray(paths)||paths.some(p=>typeof p!=='string'||!/^\/srv\/www\/html\/[^\0]*\.php$/.test(p))||new Set(paths).size!==paths.length)throw Error('invalid preload inventory');
const report={diagnostic:'preload-first-pass',mode:inventoryPath?'compile-preload':'inventory',paths,passed:false};
const {NodeKernelHost}=await import(pathToFileURL(resolve(profile,'node-kernel-host.mjs')).href);
const write=NodeKernelHost.prototype.writeFileToVfs,stats=NodeKernelHost.prototype.commonMemoryPrototypeStats,fetch=NodeKernelHost.prototype.fetchInKernel;
const encode=s=>new TextEncoder().encode(s),decode=b=>new TextDecoder().decode(b);
const script=`<?php $paths=json_decode(base64_decode('${Buffer.from(JSON.stringify(paths)).toString('base64')}'),true); $ok=0;$failed=[];foreach($paths as $path){if(opcache_compile_file($path))$ok++;else $failed[]=$path;}file_put_contents('/tmp/common-memory-preload-complete.json',json_encode(['requested'=>count($paths),'compiled'=>$ok,'failed'=>$failed]));`;
NodeKernelHost.prototype.writeFileToVfs=async function(path,data,...args){
 if(path==='/usr/sbin/php-fpm') {
  await write.call(this,'/srv/www/html/common-memory-cache-inventory.php',encode(`<?php header('Content-Type: application/json');$s=opcache_get_status(true);echo json_encode(['cachedScripts'=>array_values(array_filter(array_keys($s['scripts']??[]),fn($p)=>str_starts_with($p,'/srv/www/html/')&&!str_contains($p,'common-memory-'))),'statistics'=>$s['opcache_statistics']??null,'memory'=>$s['memory_usage']??null,'preload'=>$s['preload_statistics']??null]);`),0o644);
 }
 if(path==='/etc/php.ini'&&inventoryPath){
  const passwd=decode(await this.readFileFromVfs('/etc/passwd'));if(!/^nobody:/m.test(passwd))throw Error('missing normal FPM user nobody');
  await write.call(this,'/tmp/common-memory-preload.php',encode(script),0o644);
  report.originalIni=decode(data);report.appliedIni=report.originalIni+'\nopcache.preload=/tmp/common-memory-preload.php\nopcache.preload_user=nobody\n';data=encode(report.appliedIni);
 }
 return write.call(this,path,data,...args);
};
NodeKernelHost.prototype.fetchInKernel=async function(...args){const response=await fetch.apply(this,args);
 if(inventoryPath&&response.status>=500){const bytes=await this.readFileFromVfs('/var/log/php-fpm.log');if(bytes&&/fatal(?: error)?|ERROR:/i.test(decode(bytes)))throw Error('preload startup failed; see retained PHP-FPM log');}return response;};
let phase=0;const finalPhase=Number(process.env.KANDELO_SURVEY_WARMUP??4)+Number(process.env.KANDELO_SURVEY_ROUNDS??7);
NodeKernelHost.prototype.commonMemoryPrototypeStats=async function(...args){const value=await stats.apply(this,args);
 if(phase++===finalPhase){const response=await this.fetchInKernel(8080,{method:'GET',url:'/common-memory-cache-inventory.php',headers:{Host:'localhost'},body:null},{timeoutMs:15000,maxResponseBytes:2*1024*1024});if(response.status!==200)throw Error('cache inventory request failed');report.inventory=JSON.parse(decode(response.body));
  if(inventoryPath){const bytes=await this.readFileFromVfs('/tmp/common-memory-preload-complete.json');if(bytes)report.completion=JSON.parse(decode(bytes));}
 }
 return value;
};
try{await import('./wordpress-node.ts');}catch(error){report.error=String(error);process.exitCode=1;}
finally{NodeKernelHost.prototype.writeFileToVfs=write;NodeKernelHost.prototype.commonMemoryPrototypeStats=stats;NodeKernelHost.prototype.fetchInKernel=fetch;}
try{const result=JSON.parse(readFileSync(resolve(out,'result.json')));result.diagnostic='preload-first-pass';if(report.appliedIni){result.trial.fixtureIniBeforePreload=result.trial.phpIni;result.trial.phpIni=report.appliedIni;}writeFileSync(resolve(out,'result.json'),JSON.stringify(result,null,2)+'\n');
 if(!result.trial?.passed||!result.destroyed||!report.inventory?.cachedScripts.length)throw Error('incomplete preload app/inventory');
 if(inventoryPath&&(!report.inventory.preload||report.completion?.compiled!==paths.length||report.completion.failed.length))throw Error('native PHP preload did not complete requested inventory');report.passed=true;
}catch(error){report.error=String(error);process.exitCode=1;}
writeFileSync(resolve(out,'preload.json'),JSON.stringify(report,null,2)+'\n');
if(report.inventory)writeFileSync(resolve(out,'inventory.json'),JSON.stringify(report.inventory,null,2)+'\n');
console.log(JSON.stringify({mode:report.mode,passed:report.passed,requested:paths.length,cached:report.inventory?.cachedScripts.length,error:report.error}));
