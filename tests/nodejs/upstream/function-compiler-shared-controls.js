async function runFunctionCompilerControls(){
 const observations=[];let failures=0;
 function assert(value,message='native function compiler assertion failed'){if(!value)throw Error(message)}
 function thrown(callback){try{callback()}catch(error){return error}throw Error('expected exception')}
 async function check(name,callback){try{observations.push({name,status:'pass',detail:await callback()??true})}catch(error){failures++;observations.push({name,status:'fail',error:{name:error.name,message:error.message}})}}
 const make=(body,filename='fixture:native-function.js',target=globalThis)=>compileBody(target,filename,body);
 await check('actual-function-metadata-and-native-known-formals',()=>{
  const fn=make('return arguments.length;');assert(typeof fn==='function'&&fn.name===''&&fn.length===3);return {name:fn.name,length:fn.length,called:fn(1,2,3,4)};
 });
 await check('actual-arguments-receiver-and-return-values',()=>{
  const fn=make('return [require.marker,__filename,__dirname,arguments.length,this.marker];');const value=fn.call({marker:17},{marker:23},'filename','directory');assert(JSON.stringify(value)==='[23,"filename","directory",3,17]');return value;
 });
 await check('global-property-lookups-remain-live',()=>{
  globalThis.__nativeCompilerMarker=31;const fn=make('return globalThis.__nativeCompilerMarker;');assert(fn()===31);globalThis.__nativeCompilerMarker=37;assert(fn()===37);delete globalThis.__nativeCompilerMarker;return true;
 });
 await check('actual-target-global-lexical-environment-is-used',()=>{
  const target=createCompilerRealm();evaluateCompilerScript(target,'let compilerLexical=41;');const fn=make('return compilerLexical;','fixture:lexical.js',target);assert(fn()===41);evaluateCompilerScript(target,'compilerLexical=43;');assert(fn()===43);return true;
 });
 await check('native-compilation-does-not-capture-caller-lexicals',()=>{
  function caller(){const compilerCallerPrivate='not global';return make('return typeof compilerCallerPrivate;')()}
  assert(caller()==='undefined');return true;
 });
 await check('foreign-function-and-returned-intrinsics-belong-to-target-realm',()=>{
  const target=createCompilerRealm(),fn=make('return [Array,Object,Promise,globalThis];','fixture:foreign.js',target),value=fn();
  assert(Object.getPrototypeOf(fn)===evaluateCompilerScript(target,'Function.prototype'));assert(value[0]===evaluateCompilerScript(target,'Array')&&value[1]===evaluateCompilerScript(target,'Object')&&value[2]===evaluateCompilerScript(target,'Promise')&&value[3]===evaluateCompilerScript(target,'globalThis'));return true;
 });
 await check('replacing-public-function-does-not-intercept-native-compiler',()=>{
  const target=createCompilerRealm();evaluateCompilerScript(target,'globalThis.Function=function(){throw Error("PUBLIC_FUNCTION_INTERCEPTED")};');const fn=make('return require.marker;','fixture:intrinsic.js',target);assert(fn({marker:47})===47);return true;
 });
 await check('complete-unicode-body-and-identifier-semantics-are-preserved',()=>{
  const body='const 𝒜="é😀";return [𝒜,𝒜.length];',fn=make(body);assert(Function.prototype.toString.call(fn).includes(body));const result=fn();assert(JSON.stringify(result)==='["é😀",3]');return result;
 });
 await check('embedded-nul-in-source-literal-is-not-truncated',()=>{
  const body='return "a'+String.fromCharCode(0)+'b";',fn=make(body),result=fn();assert(result.length===3&&result.charCodeAt(1)===0&&Function.prototype.toString.call(fn).includes(body));return Array.from(result,value=>value.charCodeAt(0));
 });
 await check('unpaired-utf16-source-unit-is-not-replaced',()=>{
  const body='return "'+String.fromCharCode(0xd800)+'";',fn=make(body);assert(fn().charCodeAt(0)===0xd800&&Function.prototype.toString.call(fn).includes(body));return fn().charCodeAt(0);
 });
 await check('compiled-source-outlives-original-rope-and-full-gc',async()=>{
  let body='/*'+('retained-source-'.repeat(8192))+'*/return __filename;',fn=make(body);const length=body.length;body=null;await collectCompilerGarbage();assert(fn('unused','actual-file')==='actual-file'&&Function.prototype.toString.call(fn).length>length);return true;
 });
 await check('nested-closures-retain-real-arguments-and-live-object-identity',async()=>{
  let fn=make('return function(){return [require.marker,__filename,__dirname]};');const marker={marker:53},inner=fn(marker,'f','d');fn=null;await collectCompilerGarbage();marker.marker=59;assert(JSON.stringify(inner())==='[59,"f","d"]');return true;
 });
 await check('reentrant-full-gc-preserves-running-function-and-arguments',()=>{
  const fn=make('require.collect();return [require.marker,__filename,__dirname];');const result=fn({marker:61,collect:compilerFullGC},'f','d');assert(JSON.stringify(result)==='[61,"f","d"]');return result;
 });
 await check('strict-and-sloppy-receiver-rules-use-real-engine-semantics',()=>{
  const strict=make('"use strict";return this;'),sloppy=make('return [typeof this,this.valueOf()];');assert(strict.call(undefined)===undefined&&strict.call(3)===3);assert(JSON.stringify(sloppy.call(3))==='["object",3]');return true;
 });
 await check('actual-constructor-prototype-and-new-target-semantics',()=>{
  const fn=make('this.marker=require;this.target=new.target;'),value=new fn(67);assert(Object.getPrototypeOf(value)===fn.prototype&&value.marker===67&&value.target===fn);return true;
 });
 await check('syntax-errors-are-real-parser-exceptions',()=>{
  for(const body of ['return )','let x;let x;','"use strict";with({}){}','await 0'])assert(thrown(()=>make(body,'fixture:syntax.js')).name==='SyntaxError');return 4;
 });
 await check('foreign-parser-exceptions-preserve-target-prototype-and-restore-caller',()=>{
  const target=createCompilerRealm(),error=thrown(()=>make('return )','fixture:foreign-syntax.js',target));
  assert(error.name==='SyntaxError'&&error instanceof evaluateCompilerScript(target,'SyntaxError'));assert(make('return 79;')()===79);return {name:error.name,targetRealm:true};
 });
 await check('thrown-values-retain-identity',()=>{
  const marker={identity:'actual thrown object'},fn=make('throw require.marker;','fixture:throw.js');assert(thrown(()=>fn({marker}))===marker);return true;
 });
 await check('body-line-and-unicode-diagnostic-origin-are-real',()=>{
  const fn=make('\n\nreturn new Error("native body origin");','fixture:é😀.js'),location=compilerErrorLocation(fn());assert(location.file==='fixture:é😀.js'&&location.line===3,JSON.stringify(location));return location;
 });
 await check('actual-promise-and-await-jobs-retain-function-environment',async()=>{
  let fn=make('return (async()=>{await 0;return [require.marker,__filename,__dirname]})()');const promise=fn({marker:71},'f','d');fn=null;await collectCompilerGarbage();const value=await promise;assert(JSON.stringify(value)==='[71,"f","d"]');return value;
 });
 await check('compiler-does-not-cache-otherwise-unreachable-function-objects',async()=>{
  function allocate(){let fn=make('return 73;','fixture:weak.js');const weak=new WeakRef(fn);fn=null;return weak}
  const weak=allocate();await collectCompilerGarbage();assert(weak.deref()===undefined,'function remained strongly cached');return true;
 });
 return {cases:observations.length,failures,observations};
}
