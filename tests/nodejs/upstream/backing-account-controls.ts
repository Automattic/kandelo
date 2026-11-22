const setup=`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();const bytes=()=>api.nativeOwners('nativeBackingBytes'),call=(...args)=>api.aliased(...args),collect=()=>{clearKeptObjects();gc(undefined,'shrinking')};function assert(value){if(!value)throw Error('native backing allocation account assertion')}`;
export const backingAccountCases=[
 {name:'native-backing-account-counts-allocations-once-across-alias-reserve-and-gc',code:0,stdout:'BACKING_ALLOCATION_LIFETIME_OK',source:setup+`
 collect();const baseline=bytes();
 function allocate(){
  const id=call('create','Uint8Array',4096),copy=call('copy',id),view=call('array',id);
  assert(bytes()===baseline+4096&&view===call('array',copy));view[37]=91;
  call('reserve',id,8192);assert(bytes()===baseline+4096+8192&&call('array',id)[37]===91&&view[37]===91);
  call('destroy',copy);return id;
 }
 const id=allocate();collect();assert(bytes()===baseline+8192);
 call('destroy',id);collect();assert(bytes()===baseline);print('BACKING_ALLOCATION_LIFETIME_OK');`},
 {name:'native-backing-account-survives-detach-until-retained-native-span-releases',code:0,stdout:'BACKING_RETAINED_SPAN_OK',source:setup+`
 const binding=realm.internalBinding('buffer');collect();const baseline=bytes();
 const id=call('create','Uint8Array',4096),view=call('array',id);view.fill(0x61);call('destroy',id);
 assert(bytes()===baseline+4096);let transferred;
 const result=binding.utf8Slice(view,{valueOf(){
  transferred=view.buffer.transfer(8192);collect();assert(view.byteLength===0&&bytes()===baseline+4096);return 0;
 }},4);
 assert(result==='aaaa'&&transferred.byteLength===8192&&new Uint8Array(transferred)[0]===0x61);
 collect();assert(bytes()===baseline);print('BACKING_RETAINED_SPAN_OK');`},
];
