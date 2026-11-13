const setup=`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();const op=(name,...args)=>api.nativeOwners(name,...args);function collect(){clearKeptObjects();gc(undefined,'shrinking')}function assert(value){if(!value)throw Error('native state assertion')}`;
export const nativeStateCases=[
 {name:'native-private-data-roots-and-own-hidden-property-storage',code:0,stdout:'STATE_PRIVATE_OK',source:setup+`
 assert(op('privateRoot')==='node:decorated');const parent={},payload={value:31};assert(op('privateGet',parent)===undefined);
 assert(op('privateSet',parent,payload)===true);collect();assert(op('privateGet',parent)===payload);
 assert(Reflect.ownKeys(parent).length===0&&Object.getOwnPropertySymbols(parent).length===0);
 const child=Object.create(parent);assert(op('privateGet',child)===undefined);Object.freeze(child);assert(op('privateSet',child,73));assert(op('privateGet',child)===73&&op('privateGet',parent)===payload);
 print('STATE_PRIVATE_OK');`},
 {name:'native-private-access-bypasses-proxy-traps-and-crosses-realms',code:0,stdout:'STATE_PROXY_OK',source:setup+`
 let traps=0;const target={},handler={get(){traps++;throw 1},defineProperty(){traps++;throw 2},ownKeys(){traps++;throw 3}};
 const {proxy,revoke}=Proxy.revocable(target,handler);assert(op('privateGet',proxy)===undefined);assert(op('privateSet',proxy,41));assert(op('privateGet',proxy)===41&&op('privateGet',target)===undefined);revoke();collect();assert(op('privateGet',proxy)===41&&op('privateSet',proxy,42)&&op('privateGet',proxy)===42&&traps===0);
 const other=newGlobal({newCompartment:true}),foreign=other.eval('({})'),payload={foreign:true};assert(op('privateSet',foreign,payload));collect();assert(op('privateGet',foreign)===payload&&Reflect.ownKeys(foreign).length===0);
 print('STATE_PROXY_OK');`},
 {name:'native-error-classification-and-length-preserving-utf8-literal',code:0,stdout:'STATE_TYPES_OK',source:setup+`
 class CustomError extends RangeError{};const error=new Error('real'),foreign=newGlobal({newCompartment:true}).eval('new TypeError("foreign")');
 for(const value of [error,new AggregateError([]),new CustomError(),foreign])assert(op('errorKind',value)===true);
 let traps=0;for(const value of [{},Object.create(Error.prototype),new Proxy(error,{get(){traps++;throw 1}}),null,19])assert(op('errorKind',value)===false);assert(traps===0);
 const literal=op('nativeLiteral');assert(literal==='a\\0λ'&&literal.length===3);collect();assert(literal.charCodeAt(1)===0);
 print('STATE_TYPES_OK');`},
 {name:'native-fatal-callback-accessors-share-existing-javascript-owner',code:0,stdout:'STATE_FATAL_OK',source:setup+`
 op('fatalSet',undefined,undefined);assert(op('fatalBefore')===undefined&&op('fatalAfter')===undefined);
 const before=value=>['before',value],after=value=>['after',value];op('fatalSet',before,after);collect();assert(op('fatalBefore')===before&&op('fatalAfter')===after);
 const nextBefore=value=>value,nextAfter=value=>value,errors=realm.internalBinding('errors');errors.setEnhanceStackForFatalException(nextBefore,nextAfter);collect();assert(op('fatalBefore')===nextBefore&&op('fatalAfter')===nextAfter);
 const payload={same:true};assert(op('fatalBefore')(payload)===payload);op('fatalSet',undefined,undefined);assert(op('fatalBefore')===undefined&&op('fatalAfter')===undefined);
 print('STATE_FATAL_OK');`},
 {name:'native-source-callback-roots-propagate-reentry-and-original-exceptions',code:0,stdout:'STATE_CALLBACK_OK',source:setup+`
 let callback=input=>input.value+1;const weak=new WeakRef(callback);op('sourceSet',false,callback);callback=null;collect();collect();assert(weak.deref()&&op('sourceCall',false,{value:7})===8);
 const cache=value=>value;op('sourceSet',true,cache);assert(op('sourceGet',true)===cache);collect();
 const thrown={original:true};op('sourceSet',false,()=>{op('sourceSet',false,undefined);collect();throw thrown});let caught;try{op('sourceCall',false,{})}catch(error){caught=error}assert(caught===thrown&&op('sourceGet',false)===undefined&&op('sourceGet',true)===cache);
 op('sourceSet',true,undefined);assert(op('sourceGet',true)===undefined);print('STATE_CALLBACK_OK');`},
 {name:'native-environment-fatal-getters-use-principal-context-from-another-active-realm',code:0,stdout:'STATE_CONTEXT_OK',source:setup+`
 const before=value=>value,after=value=>value;op('fatalSet',before,after);
 const other=newGlobal({newCompartment:true});api.initializeContext(other);const foreign=other.eval('(value)=>value+2');
 api.getErrorBinding(other).setEnhanceStackForFatalException(foreign,foreign);collect();
 assert(op('fatalBefore',other)===before&&op('fatalAfter',other)===after);
 op('fatalSet',undefined,undefined);assert(op('fatalBefore',other)===undefined&&op('fatalAfter',other)===undefined);
 print('STATE_CONTEXT_OK');`},
 {name:'native-error-flags-reflect-real-independent-environment-state',code:0,stdout:'STATE_FLAGS_OK',source:setup+`
 let state=op('errorFlags');assert(state.printed===false&&state.sourceMaps===false);
 state=op('errorFlags',true,true);assert(state.printed===true&&state.sourceMaps===true);collect();state=op('errorFlags');assert(state.printed===true&&state.sourceMaps===true);
 state=op('errorFlags',false,true);assert(state.printed===false&&state.sourceMaps===true);state=op('errorFlags',false,false);assert(state.printed===false&&state.sourceMaps===false);
 print('STATE_FLAGS_OK');`},
 {name:'native-source-callback-jobs-drain-and-registered-roots-retire-at-exit',code:0,stdout:'STATE_JOB_DONE',source:setup+`
 op('sourceSet',true,value=>value);op('sourceSet',false,()=>Promise.resolve().then(()=>print('STATE_JOB_DONE')));op('sourceCall',false,undefined);`},
];
