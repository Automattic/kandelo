import {readFileSync} from 'node:fs';
export const constructorNameFixtureFiles=['tests/nodejs/upstream/constructor-name-engine-controls.ts','tests/nodejs/upstream/constructor-name-reference-controls.js','tests/nodejs/upstream/constructor-name-reference-expectations.json','tests/nodejs/upstream/constructor-name-builtin-controls.js','tests/nodejs/upstream/constructor-name-builtin-expectations.json'];
const setup=`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();const op=(name,...args)=>api.nativeOwners(name,...args);const __constructorName=value=>op('constructorName',value);function collect(){clearKeptObjects();gc(undefined,'shrinking')}function assert(value){if(!value)throw Error('native constructor-name assertion')}`;
const shared=readFileSync(constructorNameFixtureFiles[1],'utf8');
const expected=JSON.parse(readFileSync(constructorNameFixtureFiles[2],'utf8'));
const builtins=readFileSync(constructorNameFixtureFiles[3],'utf8');
const expectedBuiltins=JSON.parse(readFileSync(constructorNameFixtureFiles[4],'utf8'));
type Result={exitCode:number;stdout:string;stderr:string;hostDiagnostics:unknown[]};
function successful(result:Result){if(result.exitCode!==0||result.stderr||result.hostDiagnostics.length)throw Error(JSON.stringify(result));return JSON.parse(result.stdout)}
export const constructorNameCases=[
 {name:'native-constructor-name-original-buffer-factories-and-bound-function-match-reference',code:0,stdout:'CONSTRUCTOR_BUFFER_OK',source:setup+`
 const {Buffer}=realm.require('buffer');for(const value of [Buffer.alloc(3),Buffer.allocUnsafe(3),Buffer.from('abc'),Buffer.from([1,2]),Buffer.from(new ArrayBuffer(3))])assert(__constructorName(value)==='Buffer');
 assert(__constructorName(new Uint8Array(3))==='Uint8Array');
 const original=Object.getOwnPropertyDescriptor(Function,'name');Object.defineProperty(Function,'name',{value:'RenamedFunction',configurable:true});try{assert(__constructorName((function Original(){}).bind(null))==='Function')}finally{Object.defineProperty(Function,'name',original)}
 collect();print('CONSTRUCTOR_BUFFER_OK');`},
 {name:'native-utility-value-prerequisites-use-real-type-symbol-and-json-engines',code:0,stdout:'CONSTRUCTOR_VALUES_OK',source:setup+`
 for(const value of [undefined,null,true,17,-0,NaN,Infinity,12n,'a',Symbol('x'),()=>{},{}])assert(op('valueType',value)===typeof value);
 for(const value of [undefined,null,true,17,-0,NaN,Infinity,12n,'a',Symbol(),Symbol('λ'),Symbol.iterator])assert(op('valueDetail',value)===String(value));
 for(const value of [undefined,null,17,'a\\"b',Symbol('x'),[1,undefined],{x:'λ'}])assert(op('valueJSON',value)===String(JSON.stringify(value)));
 const originalJSON=JSON.stringify;JSON.stringify=()=>{throw Error('public JSON substitute')};try{assert(op('valueJSON',{x:1})==='{"x":1}')}finally{JSON.stringify=originalJSON}
 let calls=0;const marker={same:true};const object={get x(){calls++;collect();throw marker}};let caught;try{op('valueJSON',object)}catch(error){caught=error}assert(caught===marker&&calls===1);
 const cycle={};cycle.self=cycle;caught=undefined;try{op('valueJSON',cycle)}catch(error){caught=error}assert(caught instanceof TypeError);
 calls=0;caught=undefined;try{op('valueDetail',{toString(){calls++;return 'fake'},[Symbol.toPrimitive](){calls++;return 'fake'}})}catch(error){caught=error}assert(caught&&caught.code==='ERR_KANDELO_NOT_IMPLEMENTED'&&calls===0);
 assert(op('constructorDescription',17)==='type number (17)'&&op('constructorDescription',Symbol('λ'))==='Symbol(λ)');
 const quoted="a'b";assert(op('constructorDescription',quoted)==='type string ('+JSON.stringify(quoted)+')');
 print('CONSTRUCTOR_VALUES_OK');`},
 {name:'native-constructor-name-matches-forty-original-reference-cases-across-gc',code:0,source:setup+`const __collectConstructorGarbage=collect;const __foreignInstance=()=>newGlobal({newCompartment:true}).eval('new(class Foreign{})()');`+shared,validate:(result:Result)=>{
  const value=successful(result);if(value.kind!==expected.kind||value.cases!==40||value.observations.length!==40||JSON.stringify(value.observations.map(({name,result}:{name:string;result:string})=>({name,result})))!==JSON.stringify(expected.observations)||value.observations.some((row:{result:string;afterGC:string;calls:number})=>row.calls!==0||row.result!==row.afterGC))throw Error(result.stdout);return{status:'pass',cases:40,observations:80};
 }},
 {name:'native-constructor-name-matches-intrinsic-name-newtarget-and-subclass-reference',code:0,source:setup+builtins,validate:(result:Result)=>{
  const value=successful(result);if(value.rows.length!==57||JSON.stringify(value)!==JSON.stringify(expectedBuiltins))throw Error(result.stdout);return{status:'pass',observations:57};
 }},
 {name:'native-constructor-name-original-cpp-utility-consumer-and-hot-allocation-sites',code:0,stdout:'CONSTRUCTOR_CPP_HOT_OK',source:setup+`
 function Actual(){}function Other(){}Other.prototype.constructor=function Third(){};
 for(let i=0;i<2000;i++){const object=new Actual();assert(__constructorName(object)==='Actual');const map=Reflect.construct(Map,[],Other);assert(__constructorName(map)==='Third');const array=Reflect.construct(Array,[],Other);assert(__constructorName(array)==='Third')}
 const object=new Actual();Object.setPrototypeOf(object,null);collect();assert(op('constructorDescription',object)==='an instance of Actual');
 assert(op('constructorDescription',[])==='an instance of Array'&&op('constructorDescription',new TypeError())==='an instance of TypeError');
 print('CONSTRUCTOR_CPP_HOT_OK');`},
 {name:'native-constructor-name-reentrant-prototype-and-message-coercion-do-not-steal-origin',code:0,stdout:'CONSTRUCTOR_REENTRY_OK',source:setup+`
 let reads=0;function Other(){}Other.prototype.constructor=function Third(){};
 const target2=new Proxy(Other,{get(object,key,receiver){if(key==='prototype'){reads++;assert(__constructorName(new Map())==='Map');collect();return object.prototype}return Reflect.get(object,key,receiver)}});
 const map=Reflect.construct(Map,[],target2);assert(reads===1&&__constructorName(map)==='Third'&&reads===1);
 class DerivedError extends Error{};const error=new DerivedError({toString(){assert(__constructorName(Error('inner'))==='Error');collect();return 'outer'}});
 assert(__constructorName(error)==='DerivedError');
 class DerivedMap extends Map{set(key,value){assert(__constructorName(this)==='DerivedMap');assert(__constructorName(new Map())==='Map');collect();return super.set(key,value)}}
 const derived=new DerivedMap([[1,2]]);assert(derived.get(1)===2&&__constructorName(derived)==='DerivedMap');
 print('CONSTRUCTOR_REENTRY_OK');`},
 {name:'native-constructor-name-foreign-prototype-data-and-actual-template-identity',code:0,stdout:'CONSTRUCTOR_REALMS_TEMPLATE_OK',source:setup+`
 const other=newGlobal({newCompartment:true});other.eval('globalThis.Foreign=class Foreign{}');const object=Object.create(other.Foreign.prototype);
 assert(__constructorName(object)==='Foreign');const token=op('templateCreate',13),Constructor=op('templateGet',token),native=new Constructor();
 assert(__constructorName(native)==='NativeTemplateProbe');Object.setPrototypeOf(native,null);collect();assert(__constructorName(native)==='NativeTemplateProbe');op('templateDrop',token);
 print('CONSTRUCTOR_REALMS_TEMPLATE_OK');`},
];
