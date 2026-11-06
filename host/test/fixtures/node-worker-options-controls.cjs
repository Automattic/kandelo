'use strict';
// Candidate constructor/startup source over an intercepted native-create
// boundary, compared with actual pinned Node worker threads. No guest/JSAPI
// worker, source-native provider, or metadata capability is simulated as proof.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { Worker: NativeWorker } = require('node:worker_threads');
const { EventEmitter } = require('node:events');
const { primordials } = require('internal/test/binding');
assert.equal(process.version, 'v26.13.0');
const root = path.resolve(__dirname, '../../..');
const adapterPath = process.env.WORKER_OPTIONS_ADAPTER || path.join(root, 'third_party/node-core/worker-platform-adapter.js');
const prefixPath = process.env.WORKER_OPTIONS_PREFIX || path.join(root, 'packages/registry/spidermonkey/node-compat/adapter.js');
const source = fs.readFileSync(adapterPath, 'utf8');
const factory = Function('_createNodePrimordials', source + ';return _createNodeWorkerPlatform;')(() => primordials);
const prefix = fs.readFileSync(prefixPath, 'utf8');
const marker = '    const entryPath = workerEnvironment ?';
assert.equal(prefix.split(marker).length, 2);
const startup = Function('workerEnvironment', '_nodeNative', 'scriptPath', 'scriptArgs',
  prefix.slice(prefix.indexOf(marker)) + ';return execArgv;');
const evidence = process.env.WORKER_OPTIONS_EVIDENCE;
assert(evidence, 'Set a private evidence directory'); fs.mkdirSync(evidence, { recursive: true });
const child = 'require("node:worker_threads").parentPort.postMessage({argv:process.argv.slice(1), env:process.env.WORKER_ARGV_SENTINEL ?? null});';
const filename = path.join(evidence, 'argv-child.cjs'); fs.writeFileSync(filename, child);
const captureSentinel = {};
let captured;
const candidate = factory({
 native: {
  serializeMessage(value) { return structuredClone(value); },
  worker(operation, data, bootstrap) {
   assert.equal(operation, 'create'); captured = { data, bootstrap }; throw captureSentinel;
  },
 },
 values: { errors: require('internal/errors'), validators: require('internal/validators') },
 environment: null, ports: { adopt() { assert.fail('native create is intercepted before adoption'); } },
 EventEmitter, process, path, url: require('node:url'), isURL: require('internal/url').isURL,
 cliOptions: {},
}).api.Worker;
const normalize = error => ({ name: error.name, code: error.code, message: error.message });
function base() { return { filename: child, options: { eval: true }, trace: [] }; }
const cases = new Map();
for (const [name, argv] of [['strings',['a','b']],['numbers',[1,2n,NaN,Infinity]],
 ['symbol',[Symbol('argv')]],['null-elements',[null,undefined,false]],['empty',[]]]) {
 cases.set(name, () => ({ ...base(), options: { eval: true, argv } }));
}
for (const [name, argv] of [['undefined',undefined],['null',null],['false',false],['zero',0],['empty-string','']])
 cases.set('ignored-'+name, () => ({ ...base(), options: { eval: true, argv } }));
for (const [name, argv] of [['string','argv'],['number',1],['typed',new Uint8Array(1)],['object',{}]])
 cases.set('invalid-'+name, () => ({ ...base(), options: { eval: true, argv } }));
cases.set('sparse', () => ({ ...base(), options: { eval: true, argv: Object.assign(new Array(3),{1:'middle'}) } }));
cases.set('file', () => ({ ...base(), filename, options: { argv: ['file-arg'] } }));
cases.set('file-url', () => ({ ...base(), filename: require('node:url').pathToFileURL(filename), options: { argv: ['url-arg'] } }));
cases.set('coercion-order', () => {
 const value=base(); value.options.argv=[{toString(){value.trace.push('coerce');return 'coerced';}}];
 Object.defineProperty(value.options,'eval',{get(){value.trace.push('eval');return true;}});return value;
});
cases.set('coercion-before-env', () => {
 const value=base();value.options.env={WORKER_ARGV_SENTINEL:'before'};
 value.options.argv=[{toString(){value.options.env.WORKER_ARGV_SENTINEL='after';return 'coerced';}}];return value;
});
cases.set('coercion-before-invalid-filename', () => {
 const value=base();value.filename=123;value.options={argv:[{toString(){throw Error('argv-coercion-first');}}]};return value;
});
cases.set('coercion-selects-eval', () => {
 const value=base();value.options.eval=false;value.options.argv=[{toString(){value.options.eval=true;return 'selected';}}];return value;
});
cases.set('coercion-deselects-eval', () => {
 const value=base();value.options.argv=[{toString(){value.options.eval=false;return 'not-eval';}}];return value;
});
cases.set('argv-getter-captured', () => {
 const value=base();let reads=0;Object.defineProperty(value.options,'argv',{get(){value.trace.push('argv'+(++reads));return [reads];}});return value;
});
for (const turn of [1,2,3]) cases.set('argv-getter-throws-'+turn, () => {
 const value=base();let reads=0;Object.defineProperty(value.options,'argv',{get(){if(++reads===turn)throw Error('argv-getter-'+turn);return ['x'];}});return value;
});
cases.set('eval-getter-captured', () => {
 const value=base();let reads=0;Object.defineProperty(value.options,'eval',{get(){value.trace.push('eval'+(++reads));return reads===1;}});return value;
});
cases.set('eval-invalid-filename', () => ({...base(), filename: 1}));
cases.set('truthy-eval-object', () => ({...base(), options:{eval:{toString(){throw Error('must-not-coerce-eval');}},argv:['truthy']}}));
cases.set('species-array-like', () => {
 const value=base();class Arguments extends Array { static get [Symbol.species]() {
  value.trace.push('species');return function(length){return {length};};
 }}
 value.options.argv=new Arguments('species',7);return value;
});
cases.set('species-array-like-no-length', () => {
 const value=base();class Arguments extends Array { static get [Symbol.species]() { return function(){return {};}; } }
 value.options.argv=new Arguments('ignored',7);return value;
});
cases.set('species-length-differs', () => {
 const value=base();class Arguments extends Array { static get [Symbol.species]() { return function(){return {length:1};}; } }
 value.options.argv=new Arguments('first','second');return value;
});
function capture(spec) {
 captured=undefined;
 try { new candidate(spec.filename,spec.options); assert.fail('native create must be intercepted'); }
 catch(error) {
  if(error!==captureSentinel) return {error:normalize(error),trace:spec.trace};
 }
 const config=captured.bootstrap;
 return {value:{argv:startup(config,{},undefined,undefined).slice(1),env:config.env.WORKER_ARGV_SENTINEL ?? null},
  trace:spec.trace, config:{eval:config.eval,evalSource:config.cliOptions.evalSource}};
}
async function native(spec) {
 let worker;
 try { worker=new NativeWorker(spec.filename,spec.options); }
 catch(error){return {error:normalize(error),trace:spec.trace};}
 const trace=spec.trace;
 const result=await new Promise((resolve,reject)=>{
  let value;
  const timer=setTimeout(()=>reject(Error('native worker observation timeout')),5000);timer.unref();
  worker.once('message',message=>{value=message;});worker.once('error',reject);
  worker.once('exit',code=>{clearTimeout(timer);code===0?resolve(value):reject(Error('native worker exit '+code));});
 });
 return {value:result,trace};
}
(async()=>{
 const rows=[];
 for(const [name,make] of cases){
  if(process.env.WORKER_OPTIONS_CASE && process.env.WORKER_OPTIONS_CASE!==name) continue;
  const actual=capture(make()),expected=await native(make());
  assert.deepEqual(actual.error,expected.error,name+' error');
  assert.deepEqual(actual.trace,expected.trace,name+' observable getter/coercion order');
  if(!actual.error) {
   assert.deepEqual(actual.value,expected.value,name+' startup argv/env');
   assert.equal(actual.config.eval,actual.value.argv[0]==='[worker eval]',name+' captured eval');
   if(actual.config.eval) assert.equal(actual.config.evalSource,child,name+' eval source');
  }
  rows.push({name,source:actual,native:expected});
 }
 // Main-thread vectors retain their preexisting file/-e behavior.
 assert.deepEqual(startup(null,{},'/main.cjs',['a']),['node','/main.cjs','a']);
 assert.deepEqual(startup(null,{},'', ['a']),['node','a']);
 fs.writeFileSync(path.join(evidence,'worker-options-rows.json'),JSON.stringify(rows,null,2)+'\n');
 console.log(JSON.stringify({comparedCases:rows.length,mainStartupControls:2,
  source:'actual candidate constructor and exact prefix startup source; create boundary intercepted',
  sourceSha256:require('node:crypto').createHash('sha256').update(source).digest('hex'),
  prefixSha256:require('node:crypto').createHash('sha256').update(prefix).digest('hex'),
  reference:'actual pinned Node26 worker threads; message and exit observed',
  guestRuntime:'not built or executed'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
