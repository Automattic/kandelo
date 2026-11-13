const setup=`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();const op=(name,...args)=>api.nativeOwners(name,...args);function assert(value){if(!value)throw Error('handle prerequisite assertion')}function collect(){clearKeptObjects();gc(undefined,'shrinking')}`;
export const handleOwnerCases=[
 {name:'native-object-has-uses-real-properties-and-symbols-without-reading-values',code:0,stdout:'HANDLE_HAS_OK',source:setup+`
 let calls=0;const symbol=Symbol('native-has'),base={inherited:undefined};const object=Object.create(base);object.own=undefined;object[symbol]=1;Object.defineProperty(object,'accessor',{get(){calls++;throw Error('unexpected read')}});
 for(const key of ['own','inherited','accessor',symbol])assert(op('objectHas',object,key)===true);
 assert(op('objectHas',object,'missing')===false&&calls===0);object[17]=0;assert(op('objectHas',object,17));
 const key={toString(){calls++;collect();return 'own'}};assert(op('objectHas',object,key)&&calls===1);
 const marker={same:true};let caught;try{op('objectHas',object,{[Symbol.toPrimitive](){throw marker}})}catch(error){caught=error}assert(caught===marker);
 print('HANDLE_HAS_OK');`},
 {name:'native-object-has-preserves-proxy-errors-reentry-and-foreign-property-identity',code:0,stdout:'HANDLE_HAS_REALMS_OK',source:setup+`
 const marker={same:true};let calls=0;const proxy=new Proxy({x:1},{has(target,key){calls++;collect();if(key==='throw')throw marker;return Reflect.has(target,key)}});
 assert(op('objectHas',proxy,'x')&&calls===1);let caught;try{op('objectHas',proxy,'throw')}catch(error){caught=error}assert(caught===marker&&calls===2);
 const revoked=Proxy.revocable({},{});revoked.revoke();caught=undefined;try{op('objectHas',revoked.proxy,'x')}catch(error){caught=error}assert(caught instanceof TypeError);
 const other=newGlobal({newCompartment:true});other.eval('globalThis.key=Symbol("foreign");globalThis.value=Object.create({inherited:1});value[key]=2');assert(op('objectHas',other.value,'inherited')&&op('objectHas',other.value,other.key)&&!op('objectHas',other.value,Symbol('foreign')));
 print('HANDLE_HAS_REALMS_OK');`},
 {name:'native-class-template-caches-retain-real-metadata-and-retire-independent-roots',code:0,stdout:'HANDLE_CACHE_OK',source:setup+`
 assert(op('classCacheGet','handle')===undefined&&op('classCacheGet','async')===undefined&&op('handleNullRef')===false);
 // Complete the allocation/invocation frame before measuring retained roots.
 const weak=(()=>{const payload={tag:'retained'},weak=new WeakRef(payload),one=op('templateCreate',payload),two=op('templateCreate',9);
 op('classCacheSet','handle',one);op('classCacheSet','async',two);const first=op('templateGet',one);assert(first===op('classCacheGet','handle')&&first!==op('classCacheGet','async'));
 op('templateDrop',one);op('templateDrop',two);assert(new first().read()===payload&&new (op('classCacheGet','async'))().read()===9);return weak})();
 collect();assert(weak.deref().tag==='retained');op('classCacheSet','handle');collect();assert(op('classCacheGet','handle')===undefined&&weak.deref()===undefined&&typeof op('classCacheGet','async')==='function');op('classCacheSet','async');collect();assert(op('classCacheGet','async')===undefined);
 print('HANDLE_CACHE_OK');`},
 {name:'native-class-template-cache-materializes-per-context-constructor-identity',code:0,stdout:'HANDLE_CACHE_REALMS_OK',source:setup+`
 const token=op('templateCreate',37);op('classCacheSet','handle',token);const first=op('classCacheGet','handle');const other=newGlobal({newCompartment:true});api.initializeContext(other);api.initializeRealm(other);
 const foreign=op('classCacheGet','handle',other);assert(first!==foreign&&foreign===op('classCacheGet','handle',other));collect();assert(first===op('classCacheGet','handle')&&new foreign().read()===37);
 op('templateDrop',token);collect();assert(new first().read()===37);op('classCacheSet','handle');assert(op('classCacheGet','handle')===undefined);assert(new foreign().read()===37);print('HANDLE_CACHE_REALMS_OK');`},
];
