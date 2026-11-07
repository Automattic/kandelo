'use strict';
// Same pinned public zlib algorithms and private candidate constructors. The
// new actual native admission policy gates real native Zstd handle init;
// stream/buffer/async/codec contexts remain explicit native control boundaries.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../../..');
const metadata=JSON.parse(fs.readFileSync(path.join(root,'third_party/node-core/sources.json'),'utf8'));
const source=fs.readFileSync(path.join(root,'third_party/node-core',metadata.streamPlatform.zlib.path),'utf8');
assert.equal(crypto.createHash('sha256').update(source).digest('hex'),metadata.streamPlatform.zlib.sha256);
const bundle=fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
const factory=Function(bundle+';return _createNodeCompressionBinding;')();
const saved=['internalBinding','primordials'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]);
const testBinding=require('internal/test/binding'),internalBinding=testBinding.internalBinding,primordials=testBinding.primordials;
for(const [k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k]}
const backend=internalBinding('zlib'),constants=internalBinding('constants').zlib;
const policy=require(process.env.ZSTD_PLEDGE_COMPONENT);
exports.create=function(){
 const binding=factory({compressionConstants:constants,native:{crc32:backend.crc32,createCompressionHandle(mode,prototype){
  const Constructor=mode===constants.BROTLI_ENCODE?backend.BrotliEncoder:mode===constants.BROTLI_DECODE?backend.BrotliDecoder:mode===constants.ZSTD_COMPRESS?backend.ZstdCompress:mode===constants.ZSTD_DECOMPRESS?backend.ZstdDecompress:backend.Zlib;
  const handle=new Constructor(mode);
  for(let current=Object.getPrototypeOf(handle);current&&current!==Object.prototype;current=Object.getPrototypeOf(current))for(const key of Reflect.ownKeys(current))if(key!=='constructor'&&!Object.hasOwn(handle,key))Object.defineProperty(handle,key,Object.getOwnPropertyDescriptor(current,key));
  if(mode===constants.ZSTD_COMPRESS||mode===constants.ZSTD_DECOMPRESS){const nativeInit=handle.init;Object.defineProperty(handle,'init',{configurable:true,writable:true,value:function init(...args){
   // Native dependency InitStream commits its own wrapper lifetime before its
   // pledge check; our guest owner has separate safe pre-init RAII. Keep that
   // real dependency initialized/closed correctly even for rejected controls.
   let result,nativeError;try{result=Reflect.apply(nativeInit,this,args)}catch(error){nativeError=error}
   policy.validate(args[1]);
   if(nativeError){if(nativeError.message.startsWith('pledgedSrcSize'))throw Error('Candidate policy admitted a native-rejected pledge');throw nativeError}
   return result;
  }})}
  Object.setPrototypeOf(handle,prototype);return handle;
 }}});
 const module={exports:{}};
 Function('module','exports','require','primordials','internalBinding','process',source)(module,module.exports,require,primordials,name=>name==='zlib'?binding:internalBinding(name),process);
 return module.exports;
};
