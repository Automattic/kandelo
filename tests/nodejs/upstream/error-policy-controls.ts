import {readFileSync} from 'node:fs';
const headerPath='third_party/nodejs/upstream/src/node_errors.h';
const header=readFileSync(headerPath,'utf8').replace(/\\\r?\n/g,'');
const codes=Array.from(header.slice(header.indexOf('#define ERRORS_WITH_CODE(V)'),header.indexOf('// If the macros are used')).matchAll(/V\((ERR_[A-Z_]+),\s*(Error|TypeError|RangeError|SyntaxError)\)/g),match=>[match[1],match[2]]);
const predefined=Array.from(header.slice(header.indexOf('#define PREDEFINED_ERROR_MESSAGES(V)'),header.indexOf('#define V(code, message)')).matchAll(/V\((ERR_[A-Z_]+),\s*((?:"(?:\\.|[^"\\])*"\s*)+)\)/g),match=>[match[1],Array.from(match[2].matchAll(/"(?:\\.|[^"\\])*"/g),part=>JSON.parse(part[0])).join('')]);
if(codes.length!==97||predefined.length!==49)throw Error('Incomplete original error metadata review');
export const errorPolicyFixtureFiles=[headerPath,'tests/nodejs/upstream/error-policy-controls.ts'];
const setup=`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();const error=(...args)=>api.nativeOwners('errorFactory',...args);function assert(value){if(!value)throw Error('original error policy assertion')}`;
export const errorPolicyCases=[
 {name:'all-original-native-error-code-templates-use-real-error-types',code:0,stdout:'ERROR_CODES_OK:'+codes.length,source:setup+`
 const codes=${JSON.stringify(codes)};const constructors={Error,TypeError,RangeError,SyntaxError};let checks=0;
 for(const [code,kind] of codes){const value=error('create',code,'literal %s \\u0000 漢字 😀');assert(Object.getPrototypeOf(value)===constructors[kind].prototype&&value.name===kind&&value.message==='literal %s \\u0000 漢字 😀'&&value.code===code);
  const codeProperty=Object.getOwnPropertyDescriptor(value,'code'),message=Object.getOwnPropertyDescriptor(value,'message');assert(codeProperty.value===code&&codeProperty.enumerable&&codeProperty.writable&&codeProperty.configurable&&!message.enumerable&&message.writable&&message.configurable);checks++;if(checks%9===0)gc()}
 print('ERROR_CODES_OK:'+checks);
 `},
 {name:'original-predefined-messages-special-limits-and-formatter',code:0,stdout:'ERROR_MESSAGES_OK:'+predefined.length,source:setup+`
 const messages=${JSON.stringify(predefined)};const types=new Map(${JSON.stringify(codes)}),constructors={Error,TypeError,RangeError,SyntaxError};
 for(const [code,message] of messages){const value=error('predefined',code);assert(value.code===code&&value.message===message&&Object.getPrototypeOf(value)===constructors[types.get(code)].prototype)}
 const long=error('predefined','ERR_STRING_TOO_LONG'),large=error('predefined','ERR_BUFFER_TOO_LARGE');assert(long.code==='ERR_STRING_TOO_LONG'&&/^Cannot create a string longer than 0x[0-9a-f]+ characters$/.test(long.message));assert(large.code==='ERR_BUFFER_TOO_LARGE'&&/^Cannot create a Buffer larger than 0x[0-9a-f]+ bytes$/.test(large.message));
 const formatted=error('formatted','ERR_OUT_OF_RANGE','label=%s hex=%x upper=%X oct=%o bool=%d escape=%%','漢字\\u0000x');assert(formatted instanceof RangeError&&formatted.code==='ERR_OUT_OF_RANGE'&&formatted.message==='label=漢字\\u0000x hex=1a upper=1A oct=11 bool=true escape=%');
 print('ERROR_MESSAGES_OK:'+messages.length);
 `},
 {name:'intrinsic-errors-preserve-utf16-and-ignore-replaced-global-constructors',code:0,stdout:'ERROR_INTRINSICS_OK:4',source:setup+`
 const constructors={Error,TypeError,RangeError,SyntaxError},message='utf16\\u0000\\ud800|\\udfff😀';
 for(const name of Object.keys(constructors))globalThis[name]=function(){throw 'global constructor invoked'};
 for(const [name,Constructor] of Object.entries(constructors)){const value=error('intrinsic',name,message);assert(Object.getPrototypeOf(value)===Constructor.prototype&&value.name===name&&value.message===message&&!Object.hasOwn(value,'code'));gc()}
 const coded=error('create','ERR_INVALID_ARG_TYPE','after replacement');assert(Object.getPrototypeOf(coded)===constructors.TypeError.prototype&&coded.message==='after replacement');print('ERROR_INTRINSICS_OK:4');
 `},
 {name:'original-throw-templates-and-sole-native-root-survive-moving-gc',code:0,stdout:'ERROR_THROW_ROOT_OK',source:setup+`
 let caught;try{error('throw','ERR_INVALID_ARG_TYPE','throw %s \\u0000 detail')}catch(value){caught=value}assert(caught instanceof TypeError&&caught.code==='ERR_INVALID_ARG_TYPE'&&caught.message==='throw %s \\u0000 detail');
 const result=api.nativeOwners('catch','capture',()=>{throw error('create','ERR_OUT_OF_RANGE','only native catch retains this error')},()=>{gc();gc();const pressure=Array.from({length:4000},(_,i)=>({i,text:'root pressure '+i}));gc();assert(pressure.length===4000)});
 assert(result.failed&&result.caught&&result.exception instanceof RangeError&&result.exception.code==='ERR_OUT_OF_RANGE'&&result.exception.message==='only native catch retains this error');print('ERROR_THROW_ROOT_OK');
 `},
];
export const originalErrorPolicyMetadata={codes:codes.length,predefined:predefined.length};
