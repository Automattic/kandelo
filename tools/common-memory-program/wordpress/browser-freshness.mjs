import {BrowserKernel} from '/artifacts/browser-kernel-host.mjs';
import {checkFreshness} from '/freshness.mjs';
window.run=async backend=>{
  const result={backend,stdout:[],stderr:[],diagnostics:[],generationEvents:[]};
  window.currentWordPressProbe=result;
  const stage=value=>{
    result.stage=value;
    // Plain diagnostic data survives a test deadline without exposing host or
    // guest memory to the Playwright controller.
    window.reportWordPressProbe?.({backend,stage:value,error:result.error,
      generations:result.generationEvents.map(e=>({...e})),
      diagnostics:result.diagnostics.map(e=>({...e}))}).catch(()=>{});
  };
  stage('construct');
  const host=new BrowserKernel({maxWorkers:24,
    onStdout:b=>result.stdout.push(new TextDecoder().decode(b)),
    onStderr:b=>result.stderr.push(new TextDecoder().decode(b)),
    onHostDiagnostic:e=>result.diagnostics.push(e),
    onProcessGenerationEvent:e=>result.generationEvents.push(e)});
  try {
    stage('initialize');
    await host.initFromImage({kernelWasm:await(await fetch('/kernel.wasm')).arrayBuffer(),
      vfsImage:new Uint8Array(await(await fetch('/wordpress.vfs.zst')).arrayBuffer()),lazyUrlBase:location.origin+'/'});
    stage('start-services');
    const child=await host.spawnFromVfs('/sbin/dinit',['dinit','--container','-p','/tmp/dinitctl',`wordpress-${backend}`],
      {cwd:'/',uid:0,gid:0,env:['HOME=/root','PATH=/usr/bin:/bin:/sbin:/usr/sbin','TMPDIR=/tmp','WP_APP_PATH=/','WP_PROTO=http']});
    let exited;child.exit.then(code=>{exited=code;});
    const deadline=performance.now()+180000;
    while(!await host.pickListenerTarget(8080)){
      if(exited!==undefined||performance.now()>deadline)throw Error('nginx readiness failed: '+exited);
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    let home;
    do {
      home=await host.fetchInKernel(8080,{method:'GET',url:'/',headers:{Host:'localhost'},body:null},{timeoutMs:120000});
      if(home.status>=500&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
      else break;
    } while(true);
    if(home.status!==200||!/Hello world/i.test(new TextDecoder().decode(home.body)))throw Error('WordPress homepage readiness failed: '+home.status);
    stage('source-edit');
    result.freshness=await checkFreshness(host);
    result.passed=true;
  } catch(error) {result.failureStage=result.stage;result.error=String(error.stack||error);}
  finally {
    stage('destroy');
    await host.destroy();result.destroyed=true;stage('destroyed');
    const admitted=result.generationEvents.filter(e=>e.kind==='admitted');
    const retired=result.generationEvents.filter(e=>e.kind==='retired');
    const key=e=>`${e.realmId}:${e.pid}:${e.executionId}`;
    const retiredKeys=new Set(retired.map(key));
    result.retirement={admitted:admitted.length,retired:retired.length,
      missing:admitted.filter(e=>!retiredKeys.has(key(e))).map(key),
      acknowledgedMain:retired.filter(e=>e.mainFence==='acknowledged').length,
      provenAbsentMain:retired.filter(e=>e.mainAbsent).length,
      nonquiescent:retired.filter(e=>e.leaseDisposition!=='quiescent'||e.postCommitFailed
        ||(e.mainFence!=='acknowledged'&&!e.mainAbsent)||e.threadFences==='missing'
        ||e.threads!==e.acknowledgedThreads+e.absentThreads)};
    // A sealed, never-created Worker is a valid absence fence in the normal
    // lifecycle contract. Record it separately from an actual worker ACK.
    if(!admitted.length||new Set(admitted.map(key)).size!==admitted.length
      ||retiredKeys.size!==retired.length||admitted.length!==retired.length
      ||result.retirement.missing.length||result.retirement.nonquiescent.length||result.diagnostics.length){
      result.passed=false;result.retirementError='WordPress generations did not all retire quiescently';
    }
  }
  return result;
};
