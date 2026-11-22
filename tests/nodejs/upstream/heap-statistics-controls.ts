const setup=`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();const snapshot=(noFrame=false)=>api.nativeOwners('heapSnapshot',noFrame),collect=()=>{clearKeptObjects();gc(undefined,'shrinking')};function assert(value){if(!value)throw Error('engine heap statistics assertion')}function valid(value){assert(Number.isSafeInteger(value.total)&&Number.isSafeInteger(value.used)&&Number.isSafeInteger(value.external)&&value.total>=value.used&&value.used>0&&value.external>=0);return value}`;
export const heapStatisticsCases=[
 {name:'engine-heap-measurement-includes-dense-elements-and-reclaims-pool-occupancy',code:0,stdout:'HEAP_OCCUPANCY_OK',source:setup+`
 collect();const before=valid(snapshot()),count=262144;let values=Array(count).fill(0.25);
 const allocated=valid(snapshot());assert(allocated.used>=before.used+count*4&&values[count-1]===0.25);
 values=null;collect();const released=valid(snapshot());assert(allocated.used>=released.used+count*4);
 print('HEAP_OCCUPANCY_OK');`},
 {name:'engine-external-backing-credits-follow-arraybuffers-not-views-and-resize-transfer',code:0,stdout:'HEAP_BACKING_CREDITS_OK',source:setup+`
 collect();const baseline=valid(snapshot()).external;let buffer=new ArrayBuffer(131072,{maxByteLength:524288});
 assert(valid(snapshot()).external===baseline+131072);let views=[new Uint8Array(buffer),new DataView(buffer)];
 assert(valid(snapshot()).external===baseline+131072);buffer.resize(262144);
 assert(valid(snapshot()).external===baseline+262144);let moved=buffer.transfer();
 assert(buffer.detached&&views[0].byteLength===0&&valid(snapshot()).external===baseline+262144);
 buffer=null;views=null;moved=null;collect();assert(valid(snapshot()).external===baseline);
 print('HEAP_BACKING_CREDITS_OK');`},
 {name:'engine-external-backing-credit-excludes-shared-storage-and-supports-no-frame-query',code:0,stdout:'HEAP_SHARED_CONTEXT_OK',source:setup+`
 const previous=gcparam('semispaceNurseryEnabled');gcparam('semispaceNurseryEnabled',1);
 collect();const before=valid(snapshot(true));const shared=new SharedArrayBuffer(131072),view=new Uint8Array(shared);
 view[31]=71;const after=valid(snapshot(true));assert(after.external===before.external&&view[31]===71);
 const other=newGlobal({newCompartment:true});other.buffer=other.eval('new ArrayBuffer(262144)');
 assert(valid(snapshot(true)).external===before.external+262144);other.buffer=null;collect();
 assert(valid(snapshot()).external===before.external);gcparam('semispaceNurseryEnabled',previous);print('HEAP_SHARED_CONTEXT_OK');`},
 {name:'engine-external-backing-credit-counts-adopted-storage-and-detachment-independently-of-callback-metadata',code:0,stdout:'HEAP_ADOPTED_CREDIT_OK',source:setup+`
 realm.internalBinding('buffer');collect();const baseline=valid(snapshot()).external,size=131072;
 function create(){return api.bufferNative('tracked',new Uint8Array(size))}
 const adopted=create();collect();assert(valid(snapshot()).external===baseline+size&&adopted.byteLength===size);
 api.bufferNative('clean');assert(adopted.byteLength===0&&valid(snapshot()).external===baseline);
 print('HEAP_ADOPTED_CREDIT_OK');`},
 {name:'engine-heap-query-preserves-pending-exception-values-and-throw-stacks-without-frame',code:0,stdout:'HEAP_PENDING_EXCEPTION_OK',source:setup+`
 for(const marker of [undefined,null,NaN,-0,7n,Symbol('heap'),{same:true},new Error('original heap error')]){
  let caught=false,value;try{api.nativeOwners('heapPending',marker,true)}catch(error){caught=true;value=error}
  assert(caught&&Object.is(value,marker));valid(snapshot());
 }
 print('HEAP_PENDING_EXCEPTION_OK');`},
 ...[['latin1Slice',1,'A'],['ucs2Slice',2,'中']].map(([method,width,character])=>({
  name:'engine-external-string-credit-uses-real-'+method+'-resource-lifetime',code:0,stdout:'HEAP_EXTERNAL_STRING_OK:'+width,source:setup+`
 const binding=realm.internalBinding('buffer');collect();const baseline=valid(snapshot()).external,length=1100000,width=${width};
 function create(){const bytes=new Uint8Array(length*width);if(width===1)bytes.fill(65);else{for(let index=0;index<bytes.length;index+=2){bytes[index]=0x2d;bytes[index+1]=0x4e}}return binding.${method}(bytes,0,bytes.length)}
 let string=create();collect();assert(string.length===length&&string[39]===${JSON.stringify(character)}&&valid(snapshot()).external===baseline+length*width);
 string=null;collect();assert(valid(snapshot()).external===baseline);print('HEAP_EXTERNAL_STRING_OK:'+width);`,
 })),
];
