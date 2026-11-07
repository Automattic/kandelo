'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),cp=require('node:child_process');
const project=e=>e&&Object.fromEntries(['name','message','code','library','function','reason','opensslErrorStack'].filter(k=>e[k]!==undefined).map(k=>[k,e[k]]));
function error(fn){try{fn();return null;}catch(e){return project(e);}}
const cases={
 default:()=>({}),empty:()=>({ciphers:''}),null:()=>({ciphers:null}),
 tls12:()=>({ciphers:'ECDHE-RSA-AES128-GCM-SHA256'}),
 tls13:()=>({ciphers:'TLS_AES_128_GCM_SHA256'}),
 mixed:()=>({ciphers:'TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256'}),
 level:()=>({ciphers:'ECDHE-RSA-AES128-GCM-SHA256:@SECLEVEL=0'}),
 max12:()=>({ciphers:'TLS_AES_128_GCM_SHA256',maxVersion:'TLSv1.2'}),
 min13:()=>({ciphers:'ECDHE-RSA-AES128-GCM-SHA256',minVersion:'TLSv1.3'}),
 invalid12:()=>({ciphers:'no-such-cipher'}),invalid13:()=>({ciphers:'TLS_INVALID_CIPHER'}),
 bothInvalid:()=>({ciphers:'TLS_INVALID_CIPHER:no-such-cipher'}),
 invalidType:()=>({ciphers:1}),boxed:()=>({ciphers:new String('DEFAULT')}),
 nul:()=>({ciphers:'\0no-such-cipher'}),
 invalidMin:()=>({minVersion:'bad',ciphers:'bad'}),invalidMax:()=>({maxVersion:'bad',ciphers:'bad'}),
 cipherBeforeCA:()=>({ciphers:'no-such-cipher',ca:1}),
};
async function child(mode,name){
 const addon=require(process.env.TLS_POLICY_ADDON);
 const candidate=mode==='candidate'?require('./platform.cjs').create():null;
 const req=candidate?.req||require;
 const close=[];
 try{
  if(name==='direct-internal'){
   assert(candidate);assert.equal(candidate.proc.moduleLoadList.includes('NativeModule tls'),false);
   let actual;try{candidate.tls.connect({ciphers:'TLS_AES_128_GCM_SHA256'});}catch(e){actual=e;}
   assert.equal(actual,candidate.fault);assert.equal(candidate.proc.moduleLoadList.filter(x=>x==='NativeModule tls').length,1);
   assert.equal(candidate.trace.at(-1),'TCP-fault-boundary');assert(candidate.trace.indexOf('ciphers')<candidate.trace.indexOf('TCP-fault-boundary'));
   return{expectedBeforeTCPFault:true,actualTLSOwnerInitialized:true,trace:candidate.trace,snapshot:addon.snapshot('candidate',candidate.contexts[0])};
  }
  if(name==='https-dependency'){
   const proc=candidate?.proc||process;const before=proc.moduleLoadList.filter(x=>x==='NativeModule tls').length;
   assert.equal(before,0);req('https');assert.equal(proc.moduleLoadList.filter(x=>x==='NativeModule tls').length,1);
   return{tlsDependencyInitialized:true,default:req('tls').DEFAULT_CIPHERS};
  }
  const tls=req('tls');assert.equal(req('node:tls'),tls);
  const property=Object.getOwnPropertyDescriptor(tls,'DEFAULT_CIPHERS');assert.equal(property.writable,true);assert.equal(property.enumerable,true);assert.equal(property.configurable,true);
  const original=tls.DEFAULT_CIPHERS;
  if(name==='independent'){
   const crypto=req('crypto');crypto.constants.defaultCipherList='crypto-only mutation';assert.equal(tls.DEFAULT_CIPHERS,original);
   tls.DEFAULT_CIPHERS='TLS_AES_128_GCM_SHA256';assert.equal(crypto.constants.defaultCipherList,'crypto-only mutation');
  }
  if(name==='mutable-default')tls.DEFAULT_CIPHERS='TLS_AES_128_GCM_SHA256';
  if(name==='mutable-versions'){tls.DEFAULT_MIN_VERSION='TLSv1.3';tls.DEFAULT_MAX_VERSION='TLSv1.3';}
  if(name==='empty-default')tls.DEFAULT_CIPHERS='';
  let options=cases[name]?.()||{};const getters=[];
  if(name==='getter-order')options={get ca(){getters.push('ca');return undefined;},get ciphers(){getters.push('ciphers');return'TLS_AES_128_GCM_SHA256';}};
  if(name==='getter-error')options={get ca(){getters.push('ca');throw Error('actual CA getter');},get ciphers(){getters.push('ciphers');return'bad';}};
  let context,err;
  try{
   if(candidate)context=candidate.trust.create(options);
   else{context=tls.createSecureContext(options).context;close.push(context);}
  }catch(e){err=project(e);}
  const snapshot=context?(mode==='native'?require(process.env.TLS_NATIVE_INSPECTOR).snapshot(context):addon.snapshot('candidate',context)):undefined;
  return{error:err||null,snapshot,getters,defaultOriginal:original,
   cryptoMutation:name==='independent'?req('crypto').constants.defaultCipherList:undefined};
 }finally{
  candidate?.close();for(const context of close)context.close();
 }
}
if(process.argv[2]==='child')child(process.argv[3],process.argv[4]).then(value=>console.log(JSON.stringify(value)),err=>{console.error(err);process.exitCode=1;});
else{
 const out=path.resolve(process.argv[2]);fs.mkdirSync(out,{recursive:true});const results=[];
 const names=[...Object.keys(cases),'independent','mutable-default','mutable-versions','empty-default','getter-order','getter-error','https-dependency','cli-option','direct-internal'];
 for(const name of names){const row={name};for(const mode of name==='direct-internal'?['candidate']:['native','candidate']){
  const flags=['--expose-internals'];if(name==='cli-option')flags.push('--tls-cipher-list=TLS_AES_128_GCM_SHA256');
  const command=[process.execPath,...flags,__filename,'child',mode,name];const env={...process.env};delete env.NODE_OPTIONS;
  const run=cp.spawnSync(command[0],command.slice(1),{encoding:'utf8',timeout:10000,env});
  fs.writeFileSync(path.join(out,name+'-'+mode+'.stdout'),run.stdout||'');fs.writeFileSync(path.join(out,name+'-'+mode+'.stderr'),run.stderr||'');row[mode]={command,exit:run.status,signal:run.signal,error:run.error?.message};
  try{row[mode].value=JSON.parse(run.stdout);}catch(e){row[mode].parseError=e.message;}
 }
 try{assert.equal(row.candidate.exit,0);if(row.native){assert.equal(row.native.exit,0);assert.deepEqual(row.candidate.value,row.native.value);}row.status='pass';}catch(e){row.status='fail';row.failure=e.message;}results.push(row);}
 const report={scope:'Real existing SSL_CTX pointer policy and complete pinned option/cache/default algorithms; explicit native VM/stream/crypto/FS boundaries; direct internal connect uses expected thrown pre-TCP boundary, no synthetic successful fd/handshake or guest/engine proof',pass:results.filter(x=>x.status==='pass').length,fail:results.filter(x=>x.status==='fail').length,results};fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({pass:report.pass,fail:report.fail,results:results.map(({name,status,failure})=>({name,status,failure}))},null,2));process.exitCode=report.fail?1:0;
}
