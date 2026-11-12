'use strict';
const api=__kandeloUpstreamTest;api.initializeContext();api.initializeRealm();
const call=(...args)=>api.aliased(...args),collect=()=>{clearKeptObjects();gc('shrinking')};
const observations=[];let failures=0;
function assert(value,message='original AliasedBuffer assertion failed'){if(!value)throw Error(message)}
function thrown(callback){try{callback()}catch(error){return error}throw Error('expected exception')}
function check(name,callback){try{observations.push({name,status:'pass',detail:callback()??true})}catch(error){failures++;observations.push({name,status:'fail',error:{name:error.name,message:error.message,stack:error.stack}})}}
for(const [name,width] of [['Int8Array',1],['Uint8Array',1],['Int16Array',2],['Uint16Array',2],['Int32Array',4],['Uint32Array',4],['Float32Array',4],['Float64Array',8],['BigInt64Array',8],['BigUint64Array',8]]){
 check('original-aliased-'+name+'-shares-native-and-js-storage',()=>{
  const id=call('create',name,4),view=call('array',id),big=name.startsWith('Big'),zero=big?0n:0;
  assert(Object.prototype.toString.call(view)==='[object '+name+']'&&view.length===4&&view.byteOffset===0&&view.byteLength===4*width&&view.buffer.byteLength===4*width);
  assert(Array.from(view).every(value=>value===zero));call('write',id,2,9);assert(view[2]===(big?9n:9));view[1]=big?7n:7;
  collect();assert(call('array',id)===view&&call('read',id,1)===7&&call('read',id,2)===9);call('destroy',id);assert(view[2]===(big?9n:9));return {width,elements:4};
 });
}
check('original-copy-keeps-the-same-view-and-independent-strong-root',()=>{
 const first=call('create','Uint32Array',4),view=call('array',first),copy=call('copy',first);
 assert(call('array',copy)===view);call('write',first,1,37);assert(call('read',copy,1)===37);call('destroy',first);collect();
 assert(call('array',copy)===view&&call('read',copy,1)===37);call('destroy',copy);return true;
});
check('original-reserve-copies-prefix-and-zero-initializes-growth',()=>{
 const id=call('create','Uint32Array',4),old=call('array',id);old.set([11,22,33,44]);const grown=call('reserve',id,9);collect();
 assert(grown!==old&&grown.buffer!==old.buffer&&grown.length===9&&old.length===4&&JSON.stringify(Array.from(grown))==='[11,22,33,44,0,0,0,0,0]');
 call('write',id,0,55);assert(grown[0]===55&&old[0]===11);old[1]=66;assert(call('read',id,1)===22);call('destroy',id);return true;
});
check('original-subviews-share-backing-at-actual-aligned-offsets',()=>{
 const owner=call('create','Uint8Array',32),bytes=call('array',owner),first=call('subview',owner,'Uint32Array',4,2),second=call('subview',owner,'Float64Array',16,2);
 const ints=call('array',first),floats=call('array',second);assert(ints.buffer===bytes.buffer&&floats.buffer===bytes.buffer&&ints.byteOffset===4&&floats.byteOffset===16);
 call('write',first,1,63);assert(new Uint32Array(bytes.buffer,4,2)[1]===63);new Float64Array(bytes.buffer,16,2)[0]=12.5;assert(call('read',second,0)===12.5);
 call('destroy',owner);collect();assert(call('read',first,1)===63&&call('read',second,0)===12.5);call('destroy',first);call('destroy',second);return true;
});
check('weak-typed-view-is-tenured-and-updated-through-moving-gc',()=>{
 const id=call('create','Uint8Array',8),view=call('array',id);view[3]=29;const before=call('inspect',id);assert(before.nursery===true,'control did not obtain a nursery target');call('weaken',id);assert(call('inspect',id).nursery===false);
 for(let i=0;i<3;i++){collect();assert(call('array',id)===view&&call('read',id,3)===29)}
 call('destroy',id);assert(view[3]===29);return {nurseryBefore:before.nursery,nurseryAfter:false};
});
check('weak-native-owner-does-not-keep-unreachable-typed-view-alive',()=>{
 function allocate(){const id=call('create','Float64Array',8);call('weaken',id);return id}
 const id=allocate();collect();assert(call('array',id)===undefined);assert(thrown(()=>call('read',id,0)).message.includes('no longer reachable'));call('destroy',id);return true;
});
check('copy-of-a-weak-owner-installs-an-independent-strong-root',()=>{
 const id=call('create','Uint8Array',8);call('weaken',id);const copy=call('copy',id);collect();assert(call('array',id)===call('array',copy));
 call('destroy',copy);collect();assert(call('array',id)===undefined);call('destroy',id);return true;
});
check('release-drops-only-the-native-global-reference',()=>{
 const id=call('create','Int16Array',4),view=call('array',id);call('write',id,2,51);call('release',id);collect();
 assert(call('array',id)===undefined&&view[2]===51);view[1]=27;assert(view[1]===27);call('destroy',id);return true;
});
check('private-controls-reject-detached-native-pointer-use',()=>{
 const id=call('create','Uint8Array',8),view=call('array',id);api.detachBufferWithKey(view.buffer,undefined);
 assert(view.byteLength===0&&call('array',id)===view);
 for(const op of ['read','write','reserve','copy','weaken'])assert(thrown(()=>call(op,id,1,1)).message.includes('backing has been detached'));
 call('destroy',id);return true;
});
check('dropping-weak-native-owner-preserves-live-js-view',()=>{
 const id=call('create','Uint8Array',8),view=call('array',id);call('weaken',id);call('destroy',id);collect();view[4]=73;assert(view[4]===73);return true;
});
check('invalid-private-control-inputs-remain-visible-errors',()=>{
 for(const count of [0,-1,1048577,NaN,undefined])thrown(()=>call('create','Uint8Array',count));thrown(()=>call('create','Object',4));thrown(()=>call('array',-1));
 const id=call('create','Uint8Array',4);for(const index of [-1,4,NaN])thrown(()=>call('read',id,index));
 for(const value of [-1,101,NaN,Infinity,undefined])thrown(()=>call('write',id,0,value));call('destroy',id);thrown(()=>call('array',id));return true;
});
check('abandoned-weak-native-records-retire-at-gc',()=>{collect();const records=api.environment('inspect').weakRecords;assert(records===0,'abandoned weak native records survived GC: '+records);return true});
print(JSON.stringify({kind:'whole-original-aliased-buffer-controls',cases:observations.length,failures,observations,upstreamStartup:false}));if(failures)quit(1);
