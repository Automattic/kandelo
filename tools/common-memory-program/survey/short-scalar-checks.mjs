// Self-judging adapter mechanism checks, also run inside disposable browsers.
export function shortScalarChecks(api) {
 const {VirtualGroup,vmConstruct:make,vmCommitMapping:protect,vmEnsureMapping:map,vmCopyFork:fork}=api;
 let assertions=0;
 const ok=(v,s)=>{assertions++;if(!v)throw Error(s);};
 const eq=(a,b,s)=>ok(Object.is(a,b),`${s}: ${String(a)} != ${String(b)}`);
 const throws=(f,pattern)=>{let e;try{f();}catch(x){e=x;}ok(e&&pattern.test(String(e)),`expected ${pattern}: ${e}`);};
 const group=new VirtualGroup(undefined,{maximumPages:1024,scratchBytes:65536});
 const m=group.create(4,16),d=make(DataView,m.buffer),b=make(Uint8Array,m.buffer);
 const rows=[['Int8',-17],['Uint8',239],['Int16',-1234],['Uint16',0xcdef],['Int32',-0x1234567],['Uint32',0xdeadbeef],['Float32',1.25],['Float64',-Math.PI],['BigInt64',-0x123456789n],['BigUint64',0xfedcba9876543210n]];
 for(const [type,value]of rows)for(const at of [0,1,65529,65532,65535,65536,2*65536+9])for(const endian of [false,true]){
  d['set'+type](at,value,endian);eq(d['get'+type](at,endian),value,`${type} at ${at}`);
 }
 for(const Ctor of [Uint8Array,Int8Array,Uint16Array,Int16Array,Uint32Array,Int32Array,Float32Array,Float64Array,BigInt64Array,BigUint64Array]){
  const view=make(Ctor,m.buffer),v=Ctor===BigInt64Array?-35n:Ctor===BigUint64Array?35n:17;
  for(const index of [0,1,65536/Ctor.BYTES_PER_ELEMENT-1,65536/Ctor.BYTES_PER_ELEMENT]){view[index]=v;eq(view[index],v,'typed roundtrip '+Ctor.name);}
 }
 const small=make(DataView,m.buffer,10,8);
 throws(()=>small.getUint32(5),/bounds/);throws(()=>small.getInt8(-1),/offset/);throws(()=>small.getInt8(0.5),/offset/);
 let conversions=0;const value={valueOf(){conversions++;return 27;}};
 d.setUint32(32,value,true);eq(conversions,1,'value conversion once');eq(d.getUint32(32,true),27,'converted value');
 const prefix=b.slice(65530,65536);protect(m,65536,65536,1);
 conversions=0;throws(()=>d.setUint32(65535,value,true),/permissions/);eq(conversions,0,'denied split preflight precedes value conversion');
 eq(JSON.stringify([...b.slice(65530,65536)]),JSON.stringify([...prefix]),'denied split write has no prefix effect');
 throws(()=>{make(Uint32Array,m.buffer)[65536/4]=9;},/permissions/);
 protect(m,65536,65536,3);
 m.table()[2]=m.table()[0];d.setUint32(2*65536+32,239,true);eq(d.getUint32(32,true),239,'virtual aliases observe same bytes');
 const old=m.table()[0];map(m,'mmap',0,[0,65536,3,0x32,-1,0]);eq(d.getUint32(32,true),0,'same view observes remapped page');
 eq(new DataView(group.memory.buffer).getUint32(((old&-65536)>>>0)+32,true),239,'remap preserves old aliased physical payload');
 d.setUint32(32,49,true);eq(d.getUint32(2*65536+32,true),239,'remap detaches alias');
 m.table()[1]|=4;const child=group.create(4,16);ok(fork(child.buffer,m.buffer),'fork copies private mappings');
 const cd=make(DataView,child.buffer);cd.setUint32(32,51,true);eq(d.getUint32(32,true),49,'fork private state');
 cd.setUint32(65536+32,53,true);eq(d.getUint32(65536+32,true),53,'fork shared state');
 const stale=m.buffer;m.grow(1);throws(()=>make(DataView,stale).getInt8(4*65536),/bounds/);eq(make(DataView,m.buffer).getInt8(4*65536),0,'new view sees grown page');
 let calls=0;const spans=m.spans;m.spans=function(...args){calls++;return spans.apply(this,args);};
 d.getUint32(32,true);eq(calls,1,'overridden resolver remains observable');
 calls=0;make(Uint32Array,m.buffer)[8];eq(calls,1,'typed overridden resolver remains observable');delete m.spans;
 protect(m,0,65536,0);throws(()=>d.getUint8(0),/permissions/);throws(()=>make(Uint8Array,m.buffer)[0],/permissions/);
 m.table()[0]=(group.memory.buffer.byteLength+65536)|3;throws(()=>d.getUint32(0),/invalid physical/);
 return {passed:true,assertions,scope:'Internal virtual adapter values, bounds, permissions, split-write preflight, aliases, remaps, fork sharing, growth, resolver overrides and physical bounds. No CPU/guest-memory lifetime claim.'};
}
