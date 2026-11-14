import {fastcgi} from './fastcgi.mjs';
const encode=s=>new TextEncoder().encode(s);
const must=(condition,message)=>{if(!condition) throw Error(message);};
const target='/tmp/vm-cache-target.php', probe='/tmp/vm-cache-check.php';
const targetSource=version=>`<?php return (static function(){ $graph=(object)["next"=>(object)["label"=>"shared-v${version}"]]; return ["version"=>${version},"answer"=>array_sum(range(1,1000)),"label"=>$graph->next->label]; })();`;
// A real request holds one FPM worker at an ordinary VFS barrier. The other
// worker must perform publication/invalidation; releasing the barrier then
// proves that a distinct worker observes those cache changes.
const probeSource=`<?php
parse_str($_SERVER['QUERY_STRING'], $q);
$target='${target}'; $local=($local??0)+1;
if (($q['action']??'')==='hold') {
  $token=$q['token'];
  file_put_contents('/tmp/vm-entered-'.$token, (string)getmypid());
  $deadline=microtime(true)+20;
  while (!file_exists('/tmp/vm-release-'.$token)) {
    clearstatcache(); if (microtime(true)>$deadline) { http_response_code(500); exit('barrier timeout'); }
    usleep(1000);
  }
}
$before=opcache_get_status(false)['opcache_statistics'];
$cachedBefore=opcache_is_script_cached($target);
$invalidated=null; $value=null;
if (($q['action']??'')==='invalidate') $invalidated=opcache_invalidate($target,true);
else $value=include $target;
$after=opcache_get_status(false)['opcache_statistics'];
echo json_encode(['pid'=>getmypid(),'private'=>$local,'cached_before'=>$cachedBefore,
  'cached_after'=>opcache_is_script_cached($target),'invalidated'=>$invalidated,'value'=>$value,
  'before'=>$before,'after'=>$after]);
`;
export async function checkOpcache(host,port,processEvents,persist=()=>{}) {
  const evidence={requests:[],barriers:[],passed:false};
  const request=async query=>{
    const response=await fastcgi(host,port,probe,query);
    response.json=JSON.parse(response.body);
    evidence.requests.push({query,...response});persist(evidence);
    must(response.json.private===1,'request-local PHP state leaked');
    must(!response.stderr,'unexpected FastCGI stderr');
    return response.json;
  };
  let token=0;
  const held=async body=>{
    const id=String(++token), entered='/tmp/vm-entered-'+id,release='/tmp/vm-release-'+id;
    const pending=request('action=hold&token='+id);
    // Attach the rejection handler immediately, including failure before the
    // VFS barrier is reached. Teardown still joins the request below.
    let pendingError;
    pending.catch(error=>{pendingError=error;});
    let result,failure;
    try {
      const deadline=performance.now()+15000;
      let pid;
      while(!pid) {
        if(pendingError) throw pendingError;
        const bytes=await host.readFileFromVfs(entered);
        if(bytes?.length) pid=Number(new TextDecoder().decode(bytes));
        else {must(performance.now()<deadline,'worker barrier deadline');await new Promise(r=>setTimeout(r,5));}
      }
      evidence.barriers.push({token:id,pid});persist(evidence);
      result=await body(pid);
    } catch(error) {failure=error;}
    finally {
      try {await host.writeFileToVfs(release,encode('release'));}
      catch(error) {failure??=error;}
    }
    const peer=await pending.catch(error=>{failure??=error;});
    if(failure) throw failure;
    return {result,peer};
  };
  const value=(response,version)=>{
    must(response.value?.version===version && response.value.answer===500500
      && response.value.label===`shared-v${version}`,'cached pointer graph returned wrong value');
  };
  await host.writeFileToVfs(target,encode(targetSource(1)));
  await host.writeFileToVfs(probe,encode(probeSource));
  const publication=await held(async pid=>{
    const result=await request('action=include');
    must(result.pid!==pid,'publication did not run in peer');
    must(result.cached_before===false && result.cached_after===true,'first publication was not cold');
    value(result,1);return result;
  });
  must(publication.peer.pid!==publication.result.pid,'publication used one worker');
  must(publication.peer.cached_before===true,'peer did not observe published shared cache');
  must(publication.peer.after.misses===publication.result.after.misses,'peer recompiled published script');
  value(publication.peer,1);
  evidence.publication=publication;persist(evidence);
  const invalidation=await held(async pid=>{
    const result=await request('action=invalidate');
    must(result.pid!==pid && result.cached_before===true && result.invalidated===true
      && result.cached_after===false,'shared invalidation failed');
    await host.writeFileToVfs(target,encode(targetSource(2)));
    return result;
  });
  must(invalidation.peer.cached_before===false,'peer retained invalidated cached script');
  must(invalidation.peer.after.misses===invalidation.result.after.misses+1,'replacement script was not compiled exactly once');
  value(invalidation.peer,2);
  const warm=await request('action=include');
  must(warm.cached_before===true && warm.after.misses===invalidation.peer.after.misses,'warm request recompiled replacement');
  value(warm,2);
  evidence.invalidation=invalidation;persist(evidence);
  const known=new Set([publication.peer.pid,publication.result.pid]);
  const replacement=await held(async pid=>{
    const victim=[...known].find(worker=>worker!==pid);
    must(await host.signalProcess(victim,15),'could not signal FPM worker');
    const deadline=performance.now()+15000;
    let spawned;
    while(!spawned) {
      spawned=processEvents.find(event=>event.kind==='spawn' && !known.has(event.pid) && event.ppid!==undefined);
      must(performance.now()<deadline,'FPM worker replacement deadline');
      if(!spawned) await new Promise(r=>setTimeout(r,10));
    }
    const result=await request('action=include');
    must(result.pid===spawned.pid,'replacement worker did not serve probe');
    must(result.cached_before===true && result.after.misses===warm.after.misses,'replacement worker lost inherited shared cache');
    value(result,2);return {victim,spawned,result};
  });
  value(replacement.peer,2);
  evidence.replacement=replacement;
  evidence.passed=true;persist(evidence);
  return evidence;
}
