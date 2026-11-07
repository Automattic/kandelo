const fs = require('fs');
const path = require('path');
const mode = process.argv[2];
let Blob;
if (mode === 'native') ({ Blob } = require('buffer'));
else {
  const source = fs.readFileSync(process.argv[3], 'utf8');
  const start = source.indexOf('const _nodeBodyData = (() => {');
  const end = source.indexOf("\nif (typeof globalThis.Blob === 'undefined')", start);
  if (start < 0 || end < 0) throw new Error('Actual Blob owner selection missing');
  const protocol = require('internal/worker/js_transferable');
  const values = { validators: require('internal/validators'), errors: require('internal/errors'),
    util: require('internal/util'), require };
  const factory = new Function('_nodeClonePlatform', '_nodeValues', '_nodeEventPlatform', '_nodeBufferConstants', '_nodeWebPlatform',
    source.slice(start, end) + '\nreturn _nodeBodyData;');
  Blob = factory({ protocol }, values, { require }, require('buffer').constants,
    { streams: require('stream/web') }).Blob;
}
const out = [];
async function run(name, fn) {
  try { out.push({ name, result: await fn() }); }
  catch (error) { out.push({ name, unexpected: { name: error.name, code: error.code, message: error.message } }); }
}
function failure(fn, original) {
  try { fn(); return { threw: false }; }
  catch (error) { return original ? { threw: true, original: error === original } :
    { threw: true, name: error.name, code: error.code, message: error.message }; }
}
(async () => {
await run('iterable-before-options', async () => {
 const log=[]; const parts={ *[Symbol.iterator]() { log.push('iterate'); yield { toString(){log.push('part-string');return 'A';} }; log.push('done'); } };
 const blob=new Blob(parts,{get endings(){log.push('endings');return 'transparent';},get type(){log.push('type');return 'TEXT/PLAIN';}});
 return {log,text:await blob.text(),type:blob.type,size:blob.size};
});
await run('all-sequence-before-byte-copy',async()=>{
 const bytes=new Uint8Array([65]); const blob=new Blob([bytes,{toString(){bytes[0]=66;return 'C';}}]);
 return {text:await blob.text(),bytes:Array.from(await blob.bytes())};
});
await run('type-getter-before-byte-copy',async()=>{
 const bytes=new Uint8Array([65]);let reads=0;const blob=new Blob([bytes],{get type(){reads++;bytes[0]=66;return 'TEXT/PLAIN';}});
 return {reads,text:await blob.text(),type:blob.type};
});
await run('type-string-after-byte-copy',async()=>{
 const bytes=new Uint8Array([65]);let gets=0;const blob=new Blob([bytes],{get type(){gets++;return{toString(){bytes[0]=66;return 'TEXT/PLAIN';}};}});
 return {gets,text:await blob.text(),type:blob.type,source:Array.from(bytes)};
});
await run('iterator-mutates-options',async()=>{
 const opts={endings:'transparent',type:'before'};const parts={*[Symbol.iterator](){yield 'a\rb';opts.endings='native';opts.type='AFTER';}};
 const blob=new Blob(parts,opts);return{text:await blob.text(),type:blob.type};
});
await run('options-throw-after-part-conversion',()=>{
 const log=[];const original={sentinel:'options'};const parts=[{toString(){log.push('part');return 'x';}}];
 const caught=failure(()=>new Blob(parts,{get endings(){log.push('endings');throw original;}}),original);return{log,caught};
});
await run('part-throw-before-options',()=>{
 const log=[];const original={sentinel:'part'};const caught=failure(()=>new Blob([{toString(){log.push('part');throw original;}}],{get endings(){log.push('endings');return 'native';}}),original);return{log,caught};
});
await run('endings-then-type-before-endings-string',()=>{
 const log=[];const original={sentinel:'endings'};const caught=failure(()=>new Blob([],{get endings(){log.push('get-endings');return{toString(){log.push('string-endings');throw original;}};},get type(){log.push('get-type');return 't';}}),original);return{log,caught};
});
await run('options-invalid-after-iteration',()=>{
 const log=[];const parts={*[Symbol.iterator](){log.push('iterate');yield 'x';log.push('done');}};
 return{log,caught:failure(()=>new Blob(parts,1))};
});
await run('sequence-errors',()=>[null,1,'x',{}, {[Symbol.iterator]:1},{[Symbol.iterator](){return 1;}}, {[Symbol.iterator](){return{next(){return 1;}};}}].map(v=>failure(()=>new Blob(v))));
await run('symbol-part',()=>failure(()=>new Blob([Symbol('part')])));
await run('endings-validation',()=>[Symbol('end'),'other'].map(endings=>failure(()=>new Blob([],{endings}))));
await run('byte-types-copy-and-blob',async()=>{
 const ab=new ArrayBuffer(8);const u=new Uint8Array(ab);u.set([1,2,3,4]);const view=new DataView(ab,1,2);const source=new Blob(['ab']);const blob=new Blob([new Uint8Array(ab,0,2),view,source,'\ud800']);u.fill(9);
 return{bytes:Array.from(await blob.bytes()),size:blob.size,type:blob.type};
});
await run('shared-copy',async()=>{
 const raw=new SharedArrayBuffer(2);new Uint8Array(raw).set([65,66]);const blob=new Blob([raw]);new Uint8Array(raw).fill(0);return{text:await blob.text(),size:blob.size};
});
await run('function-options-single-read',async()=>{
 let e=0,t=0;function opts(){};Object.defineProperties(opts,{endings:{get(){e++;return undefined;}},type:{get(){t++;return undefined;}}});const blob=new Blob(['x'],opts);return{e,t,text:await blob.text(),type:blob.type};
});
await run('slice-webidl-errors',()=>{
 const b=new Blob(['abcdef']);return [()=>b.slice(1n),()=>b.slice(0,Symbol()),()=>b.slice(Symbol()),()=>b.slice(0,1n)].map(fn=>failure(fn));
});
await run('slice-clamp-and-mime',async()=>{
 const b=new Blob(['abcdef']);const cases=[[1.5,4.5,'TEXT/PLAIN'],[-2.5,Infinity,'x\u0001'],[NaN,undefined,false],[-Infinity,2.5,'x']];
 const out=[];for(const args of cases){const x=b.slice(...args);out.push({text:await x.text(),type:x.type,size:x.size});}return out;
});
await run('slice-conversion-order-original-errors',()=>{
 const b=new Blob(['abcdef']);const log=[];const original={sentinel:'end'};
 const caught=failure(()=>b.slice({valueOf(){log.push('start');return 1;}},{valueOf(){log.push('end');throw original;}},{toString(){log.push('type');return 'x';}}),original);return{log,caught};
});
await run('slice-type-before-byte-access',async()=>{
 const b=new Blob(['abcdef']);const log=[];const x=b.slice({valueOf(){log.push('start');return 1;}},{valueOf(){log.push('end');return 4;}},{toString(){log.push('type');return 'TEXT/PLAIN';}});
 return{log,text:await x.text(),type:x.type,size:x.size};
});
process.stdout.write(JSON.stringify(out)+'\n');
})();
