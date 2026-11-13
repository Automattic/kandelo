const setup=`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();const op=(mode,callback,second)=>api.nativeOwners('catch',mode,callback,second);function assert(value){if(!value)throw Error('scoped catch assertion')}`;
export const scopedCatchCases=[
 {name:'native-catch-retains-all-thrown-value-identities-through-gc',code:0,stdout:'CATCH_IDENTITIES_OK:10',source:setup+`
 const values=[undefined,null,NaN,-0,1n,Symbol('failure'),{sentinel:1},new Error('native catch'),'throw text',17];
 for(const value of values){const result=op('capture',()=>{throw value},()=>{gc();gc()});assert(result.failed&&result.caught&&!result.terminated&&result.canContinue&&Object.is(result.exception,value))}
 print('CATCH_IDENTITIES_OK:'+values.length);
 `},
 {name:'native-catch-allows-successful-reentry-before-exception-query',code:0,stdout:'CATCH_REENTRY_OK',source:setup+`
 const sentinel={saved:1};let reentered=false;
 const result=op('capture',()=>{throw sentinel},()=>{gc();const inner=op('capture',()=>{throw 42});assert(inner.caught&&inner.exception===42);reentered=true});
 assert(reentered&&result.caught&&result.exception===sentinel);print('CATCH_REENTRY_OK');
 `},
 {name:'native-catch-overwrites-previous-caught-value-on-later-failure',code:0,stdout:'CATCH_REPLACE_OK',source:setup+`
 const result=op('capture',()=>{throw 1},()=>{gc();throw 2});assert(result.caught&&result.exception===2);print('CATCH_REPLACE_OK');
 `},
 {name:'native-catch-reset-allows-next-success-and-next-failure',code:0,stdout:'CATCH_RESET_OK',source:setup+`
 let next=false;const success=op('reset',()=>{throw 1},()=>{gc();next=true});assert(next&&!success.resetCaught&&!success.caught&&success.exception===undefined);
 const failure=op('reset',()=>{throw 1},()=>{throw 2});assert(!failure.resetCaught&&failure.caught&&failure.exception===2);print('CATCH_RESET_OK');
 `},
 {name:'native-rethrow-survives-reset-and-reaches-javascript-handler',code:0,stdout:'CATCH_RETHROW_OK',source:setup+`
 const sentinel={rethrown:1};let caught;try{op('rethrow',()=>{gc();throw sentinel})}catch(error){caught=error}assert(caught===sentinel);print('CATCH_RETHROW_OK');
 `},
 {name:'nested-native-rethrow-preserves-real-pending-throw-stack',code:0,stdout:'CATCH_NESTED_STACK_OK',source:setup+`
 const sentinel={nested:1};const result=op('nested',()=>{gc();throw sentinel});assert(result.failed&&result.innerCaught&&result.caught&&result.exception===sentinel&&result.sameThrowStack);print('CATCH_NESTED_STACK_OK');
 `},
 {name:'native-cleanup-scope-restores-preexisting-pending-exception',code:0,stdout:'CATCH_PENDING_OK',source:setup+`
 const prior={prior:1};let caught;try{op('preservePending',()=>{gc();throw 'cleanup'},prior)}catch(error){caught=error}assert(caught===prior);print('CATCH_PENDING_OK');
 `},
 {name:'javascript-handler-precedes-outer-native-catch-on-reentry',code:0,stdout:'CATCH_JS_ORDER_OK',source:setup+`
 const sentinel={inner:1};const result=op('capture',()=>{try{api.nativeOwners('number',{valueOf(){throw sentinel}})}catch(error){assert(error===sentinel);return 41}throw Error('handler skipped')});assert(!result.failed&&!result.caught&&result.result===41);print('CATCH_JS_ORDER_OK');
 `},
 {name:'native-object-get-captures-throwing-getter-at-api-return',code:0,stdout:'CATCH_GET_OK',source:setup+`
 const sentinel={getter:1};let ran=false;const result=op('get',()=>({get owner(){gc();throw sentinel}}),()=>{ran=true;gc()});assert(ran&&result.failed&&result.caught&&result.exception===sentinel);print('CATCH_GET_OK');
 `},
 {name:'native-number-conversion-captures-throwing-coercion',code:0,stdout:'CATCH_NUMBER_OK',source:setup+`
 const sentinel={conversion:1};let ran=false;const result=op('number',()=>({valueOf(){gc();throw sentinel}}),()=>{ran=true;gc()});assert(ran&&result.failed&&result.caught&&result.exception===sentinel);print('CATCH_NUMBER_OK');
 `},
 {name:'native-catch-wraps-foreign-realm-exception-with-original-identity',code:0,stdout:'CATCH_FOREIGN_OK',source:setup+`
 const other=newGlobal({newCompartment:true});const sentinel=other.eval('globalThis.sentinel={foreign:1};sentinel');const callback=other.eval('()=>{gc();throw sentinel}');const result=op('capture',callback,()=>{gc()});assert(result.failed&&result.caught&&result.exception===sentinel);print('CATCH_FOREIGN_OK');
 `},
 {name:'native-catch-does-not-turn-real-quit-into-normal-return',code:17,stdout:'NATIVE_CATCH_TERMINATED:1:1:0',source:setup+`op('capture',()=>quit(17));throw Error('termination swallowed');`},
 {name:'native-catch-recognizes-real-uncatchable-interrupt',code:6,stdout:'NATIVE_CATCH_TERMINATED:1:1:0',stderr:'Script terminated by interrupt handler.\n',source:setup+`op('capture',()=>{setInterruptCallback(()=>false);interruptIf(true);while(true){}});throw Error('interrupt swallowed');`},
];
