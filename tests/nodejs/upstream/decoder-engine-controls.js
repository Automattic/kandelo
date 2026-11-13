'use strict';
const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm(),binding=realm.internalBinding('string_decoder');
const collect=()=>gc('shrinking'),detachBuffer=buffer=>detachArrayBuffer(buffer);
// @shared-decoder-controls
check('cached-original-binding-and-functions-survive-moving-gc',()=>{
  const decode=binding.decode;collect();assert(realm.internalBinding('string_decoder')===binding && decode===binding.decode,'lost cached identity');
  assert(decode(state('utf8'),Uint8Array.of(65))==='A','lost function owner');assert(api.inspectCodecs().spans===0,'borrow escaped call');
});
check('actual-compacting-gc-runs-while-native-state-and-input-are-borrowed',()=>{
  const before=api.inspectCodecs().collections;api.stressCodecGc(true);
  try { const s=state('utf8');assert(binding.decode(s,Uint8Array.of(0xe2))==='','partial prefix');
    assert(binding.decode(s,Uint8Array.of(0x82,0xac,65))==='€A','bytes did not survive in-call collection');
    assert(api.inspectCodecs().collections>before && api.inspectCodecs().spans===0,'no actual in-call collection or escaped borrow');
  } finally {api.stressCodecGc(false)}
});
check('other-realms-use-distinct-functions-and-live-cross-realm-views',()=>{
  const global=newGlobal({newCompartment:true});api.initializeContext(global);const other=api.initializeRealm(global),b=other.internalBinding('string_decoder');
  assert(b!==binding && b.decode!==binding.decode,'shared realm identity');collect();assert(b.decode(state('utf8'),Uint8Array.of(65))==='A','foreign input failed');
});
for(const encoding of ['latin1','utf16le'])check('real-external-'+encoding+'-resources-finalize-after-gc',()=>{
  const before=api.inspectCodecs(),count=1100000,width=encoding==='latin1'?1:2,bytes=new Uint8Array(count*width);
  if(width===1)bytes.fill(65);else for(let i=0;i<bytes.length;i+=2){bytes[i]=65;bytes[i+1]=1}
  let text=binding.decode(state(encoding),bytes);assert(text.length===count,'wrong external length');collect();
  assert(text.charCodeAt(count-1)===(width===1?65:321),'external data lost through GC');
  const live=api.inspectCodecs();assert(live.externalBytes===before.externalBytes+count*width && live.created===before.created+1,'not actual external resource ownership');
  assert(live.spans===0,'live borrow escaped return');text=null;collect();const deadline=Date.now()+5000;while(api.inspectCodecs().released<before.released+1 && Date.now()<deadline)collect();const after=api.inspectCodecs();
  assert(after.externalBytes===before.externalBytes && after.released===before.released+1,'external resource not retired');return {created:live.created-before.created,released:after.released-before.released};
});
let bootstrapFailure;
check('original-bootstrap-observes-next-real-failure-and-retires-its-binding',()=>{
  const global=newGlobal({newCompartment:true});api.initializeContext(global);const other=api.initializeRealm(global),b=other.internalBinding('string_decoder');
  let error;try{api.runNodeBootstrap(global)}catch(e){error=e}assert(error!==undefined,'node body unexpectedly completed; review next startup stages');
  bootstrapFailure={name:error.name,code:error.code,message:error.message,stack:error.stack,compiledBuiltinIds:api.inspectRealm(global).compiledBuiltinIds};
  let retired;try{b.decode(state('utf8'),Uint8Array.of(65))}catch(e){retired=e}
  assert(retired && retired.message.includes('Previous Node realm initialization failed'),'failed realm binding stayed usable');
});
print(JSON.stringify({kind:'native-decoder-controls',cases:observations.length,failures,observations,matrix,bootstrapFailure,upstreamStartup:false}));if(failures)quit(1);
