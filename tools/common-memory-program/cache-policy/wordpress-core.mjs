// Post-timing correctness check: edit a real WordPress file already restored
// from the seed. The controller is blacklisted; the included core file is not.
const encode=s=>new TextEncoder().encode(s),decode=b=>new TextDecoder().decode(b);
const controller='/srv/www/html/kandelo-seed-core-check.php';
const target='/srv/www/html/wp-includes/version.php';
const must=(ok,message)=>{if(!ok)throw Error(message);};
export async function installSeededCoreCheck(host){
 await host.writeFileToVfs(controller,encode(`<?php
header('Content-Type: application/json');include '${target}';usleep(20000);
echo json_encode(['pid'=>getmypid(),'marker'=>$kandelo_seed_marker??0,
 'cached'=>opcache_is_script_cached('${target}'),'validate'=>ini_get('opcache.validate_timestamps')]);`));
 const blacklist='/etc/php-opcache-blacklist.txt';
 await host.writeFileToVfs(blacklist,encode(decode(await host.readFileFromVfs(blacklist))+'\n'+controller+'\n'));
}
export async function verifySeededCoreCheck(host,request,result){
 async function both(marker,label){
  const values=result[label]=[],deadline=performance.now()+15000;
  do{
   values.push(...await Promise.all(Array.from({length:8},async()=>{
    const r=await request('/kandelo-seed-core-check.php');must(r.status===200,'core edit HTTP status');return JSON.parse(r.text);
   })));
   if(new Set(values.map(r=>r.pid)).size===2)break;
  }while(performance.now()<deadline);
  must(new Set(values.map(r=>r.pid)).size===2,'both workers must see core edit');
  must(values.every(r=>r.marker===marker&&r.cached&&r.validate==='1'),'core source cache freshness failed');
 }
 await both(0,'before');
 const original=await host.readFileFromVfs(target),source=decode(original);must(source.startsWith('<?php'),'unexpected core source');
 await host.writeFileToVfs(target,encode(source.replace('<?php','<?php\n$kandelo_seed_marker=2;\n')),0o644);
 await both(2,'after');result.passed=true;
}
