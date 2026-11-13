// Owning-engine primitives consumed by the complete original AsyncWrap unit.
// These do not initialize its binding or claim resource/startup compatibility.
const setup=`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();const op=(name,...args)=>api.nativeOwners(name,...args);function assert(value){if(!value)throw Error('async resource primitive assertion')}`;
export const asyncResourcePrimitiveCases=[
 {name:'contextual-native-number-coercion-preserves-errors-realms-and-gc',code:0,stdout:'ASYNC_NUMBER_PRIMITIVE_OK:18',source:setup+`
 let controls=0;function eq(input,expected){assert(Object.is(op('number',input),expected));controls++}
 eq(undefined,NaN);eq(null,0);eq(true,1);eq(false,0);eq('\\t-0\\n',-0);eq('2.75',2.75);eq('Infinity',Infinity);eq('',0);eq('0x11',17);
 eq({valueOf(){gc();return op('number','3.5')+1}},4.5);
 eq({[Symbol.toPrimitive](hint){assert(hint==='number');gc();return '9.25'}},9.25);
 eq({valueOf(){return {}},toString(){gc();return '12'}},12);
 for(const value of [Symbol('cannot-number'),1n,{[Symbol.toPrimitive](){return {}}}]){let error;try{op('number',value)}catch(caught){error=caught}assert(error?.name==='TypeError');controls++}
 const sentinel={coercionFailure:11};let caught;try{op('number',{valueOf(){gc();throw sentinel}})}catch(error){caught=error}assert(caught===sentinel);controls++;eq(1,1);
 const other=newGlobal({newCompartment:true});eq(other.eval('({valueOf(){gc();return 7.125}})'),7.125);
 assert(controls===18);print('ASYNC_NUMBER_PRIMITIVE_OK:'+controls);
 `},
 {name:'native-environment-symbols-reuse-canonical-upstream-inventory',code:0,stdout:'ASYNC_SYMBOL_PRIMITIVE_OK:4',source:setup+`
 const table=realm.internalBinding('symbols'),native=op('symbols');
 assert(typeof native.owner==='symbol'&&native.owner===table.owner_symbol&&native.resource===table.resource_symbol&&native.owner!==native.resource);
 const object={[native.owner]:41,[native.resource]:42};assert(object[table.owner_symbol]===41&&object[table.resource_symbol]===42);
 const other=newGlobal({newCompartment:true});api.initializeContext(other);const second=api.initializeRealm(other).internalBinding('symbols');assert(second.owner_symbol===native.owner&&second.resource_symbol===native.resource);
 gc();gc();const again=op('symbols');assert(again.owner===native.owner&&again.resource===native.resource);print('ASYNC_SYMBOL_PRIMITIVE_OK:4');
 `},
];
