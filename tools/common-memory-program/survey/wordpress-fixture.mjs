import {installTimestampProbe,timestampProbe} from './wordpress-policy.mjs';
import {prepareWordPressPreload,verifyWordPressPreload} from './wordpress-preload-config.mjs';
import {describeError} from './describe-error.mjs';
const encode=s=>new TextEncoder().encode(s), decode=b=>new TextDecoder().decode(b);
const must=(ok,message)=>{if(!ok) throw Error(message);};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
function setting(source,key,value) {
  const pattern=new RegExp('^'+key.replaceAll('.','\\.')+'=.*$','gm');
  must([...source.matchAll(pattern)].length===1,`expected one ${key} setting`);
  return source.replace(pattern,`${key}=${value}`);
}

export async function wordpressTrial(host,artifact,{backend='sqlite',label='vm-shared',wpConfig,
  warmup=8,rounds=7,probeRequests=0,seed=6197,validateTimestamps=true,checkTimestampPolicy=false,preloadPaths=undefined,persist=()=>{}}) {
  const shared=label.endsWith('shared');
  const result={backend,label,warmup,rounds,probeRequests,seed,artifactSha256:await hash(artifact),samples:[],memory:[],passed:false};
  let state=seed>>>0;
  const shuffled=values=>{const a=[...values];for(let i=a.length-1;i>0;i--){state^=state<<13;state^=state>>>17;state^=state<<5;const j=(state>>>0)%(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;};
  const cookies=new Map();
  const publish=()=>persist(result);
  const request=async (path,{method='GET',body=null}={})=>{
    const headers={Host:'localhost',...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{})};
    const matching=[...cookies.values()].filter(c=>path.startsWith(c.path));
    if(matching.length)headers.Cookie=matching.map(c=>`${c.name}=${c.value}`).join('; ');
    const response=await host.fetchInKernel(8080,{method,url:path,headers,body:body?encode(body):null},{timeoutMs:120000,maxResponseBytes:2*1024*1024});
    for(const [key,value] of Object.entries(response.headers)) if(key.toLowerCase()==='set-cookie') {
      for(const raw of value.split(/\r?\n|,(?=\s*[^=;,\s]+=)/)) {
        const parts=raw.trim().split(';'),pair=parts.shift(),at=pair.indexOf('=');
        if(at<1) continue;
        const name=pair.slice(0,at),value=pair.slice(at+1);
        const attrs=Object.fromEntries(parts.map(p=>{const a=p.trim().indexOf('=');return a<0?[p.trim().toLowerCase(),'']:[p.trim().slice(0,a).toLowerCase(),p.trim().slice(a+1)];}));
        const path=attrs.path??'/';
        if(value==='' || attrs['max-age']==='0')cookies.delete(name+' '+path);
        else cookies.set(name+' '+path,{name,value,path});
      }
    }
    return {...response,text:decode(response.body)};
  };
  const page=async path=>{
    let response=await request(path);
    for(let hop=0;response.status>=300&&response.status<400&&hop<8;hop++) {
      const location=Object.entries(response.headers).find(([k])=>k.toLowerCase()==='location')?.[1];
      must(location,'redirect has no Location');
      const url=new URL(location,'http://localhost');
      must(url.hostname==='localhost','unexpected external redirect');
      response=await request(url.pathname+url.search);
    }
    return response;
  };
  const successful=(response,marker)=>{
    try {
      must(response.status===200,`HTTP ${response.status}: ${response.text.slice(0,250)}`);
      must(!/<b>(Fatal error|Parse error|Warning)<\/b>:/i.test(response.text),'PHP diagnostic in response');
      must(marker.test(response.text),'response content contract failed');
    }catch(error){
      // Bounded copied response data, never a view into guest memory. Keep
      // success output shapes unchanged and preserve the original assertion.
      result.failedResponse={status:response.status,bytes:response.body.length,
        text:response.text.slice(0,16384),truncated:response.text.length>16384};
      throw error;
    }
  };
  try {
    must(['sqlite','mariadb'].includes(backend),'unknown WordPress backend');
    must(typeof validateTimestamps==='boolean'&&typeof checkTimestampPolicy==='boolean','invalid timestamp experiment options');
    await host.writeFileToVfs('/usr/sbin/php-fpm',new Uint8Array(artifact),0o755);
    await host.writeFileToVfs('/srv/www/html/wp-config.php',encode(wpConfig));
    let ini=decode(await host.readFileFromVfs('/etc/php.ini'));
    ini=setting(ini,'opcache.file_cache_only',shared?'0':'1');
    ini=setting(ini,'opcache.file_cache',shared?'':'/var/cache/opcache');
    ini=setting(ini,'opcache.validate_timestamps',validateTimestamps?'1':'0');
    if(preloadPaths!==undefined){
      ini=await prepareWordPressPreload(host,ini,preloadPaths,shared);
      result.preload={enabled:preloadPaths!==null,requested:preloadPaths?.length??0,passed:false};
    }
    await host.writeFileToVfs('/etc/php.ini',encode(ini));
    result.phpIni=ini;
    if(checkTimestampPolicy)await installTimestampProbe(host);
    const started=performance.now();
    const init=await host.spawnFromVfs('/sbin/dinit',['dinit','--container','-p','/tmp/dinitctl',`wordpress-${backend}`],
      {cwd:'/',uid:0,gid:0,env:['HOME=/root','PATH=/usr/bin:/bin:/sbin:/usr/sbin','TMPDIR=/tmp','WP_APP_PATH=/','WP_PROTO=http']});
    result.initPid=init.pid;
    init.exit.then(code=>{result.initExit=code;},error=>{result.initExit=String(error);});
    const deadline=started+180000;
    while(!await host.pickListenerTarget(8080)) {
      must(result.initExit===undefined,'dinit exited during boot');
      must(performance.now()<deadline,'nginx readiness deadline');await pause(10);
    }
    result.listenerMs=performance.now()-started;
    result.readinessStatuses=[];
    let home;
    do {
      home=await page('/');result.readinessStatuses.push(home.status);
      if(home.status<500)break;
      must(performance.now()<deadline,'WordPress readiness deadline');await pause(25);
    } while(true);
    successful(home,/Hello world/i);result.firstHomepageMs=performance.now()-started;
    successful(await page('/wp-login.php'),/id="loginform"/);
    const login=await request('/wp-login.php',{method:'POST',body:new URLSearchParams({log:'admin',pwd:'password',
      'wp-submit':'Log In',redirect_to:'http://localhost/wp-admin/',testcookie:'1'}).toString()});
    must(login.status===302 || login.status===303,`login failed: HTTP${login.status} ${login.text.slice(0,200)}`);
    successful(await page('/wp-admin/'),/id="adminmenu"/);
    result.adminLogin=true;result.cookieNames=[...new Set([...cookies.values()].map(c=>c.name))];
    const workloads=[['home','/',/Hello world/i],['article','/?p=1',/Hello world/i],
      ['admin','/wp-admin/',/id="adminmenu"/],['posts','/?rest_route=/wp/v2/posts&per_page=1',/Hello world/i]];
    const sample=async (workload,phase,round)=>{
      const [name,path,marker]=workload,start=performance.now();
      const response=await page(path),elapsedMs=performance.now()-start;successful(response,marker);
      if(name==='posts') {
        const posts=JSON.parse(response.text);
        must(Array.isArray(posts)&&posts.length===1&&posts[0].title?.rendered==='Hello world!','REST posts contract failed');
      }
      result.samples.push({workload:name,phase,round,elapsedMs,bytes:response.body.length});
    };
    const memory=async phase=>{result.memory.push({phase,...await host.commonMemoryPrototypeStats()});publish();};
    await memory('after-login');
    for(let i=0;i<probeRequests;i++) {await sample(workloads[i%workloads.length],'resource',i);await memory(`resource-${i}`);}
    for(let round=0;round<warmup;round++) {for(const work of shuffled(workloads)) await sample(work,'warmup',round);await memory(`warmup-${round}`);}
    for(let round=0;round<rounds;round++) {
      for(const work of shuffled(workloads))await sample(work,'warm',round);
      await memory(`warm-${round}`);
    }
    result.statuses=await Promise.all(Array.from({length:8},async(_,i)=>{
      const r=await request(`/common-memory-status.php?survey=${i}`);must(r.status===200,'cache status response failed');return JSON.parse(r.text);
    }));
    for(const status of result.statuses) {
      must(status.file_cache_only===(shared?'0':'1'),'wrong cache mode');
      must(status.file_cache===(shared?'':'/var/cache/opcache'),'wrong file-cache directory');
      if(shared)must(status.opcache_enabled&&status.statistics.num_cached_scripts>50,'shared cache was not populated');
    }
    must(new Set(result.statuses.map(s=>s.pid)).size===2,'both FPM workers must answer');
    const last=result.memory.at(-1);
    must(label.startsWith('native')?last.roots===0:last.groups===1&&last.roots===3,'wrong native/VM group configuration');
    if(preloadPaths!==undefined)await verifyWordPressPreload(host,request,preloadPaths,shared,result.preload);
    if(checkTimestampPolicy) {
      result.timestampPolicy={validateTimestamps};
      await timestampProbe(request,validateTimestamps,shared,result.timestampPolicy);
    }
    result.passed=true;
  } catch(error) {result.error=describeError(error);}
  finally {
    for(const path of ['/var/log/php-fpm.log','/var/log/nginx.log']) {
      const bytes=await host.readFileFromVfs(path).catch(()=>null);if(bytes) (result.logs??={})[path]=decode(bytes);
    }
    publish();
  }
  return result;
}
