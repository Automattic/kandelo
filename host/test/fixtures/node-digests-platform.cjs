'use strict';
// Actual public algorithms. The compiled OpenSSL owner is selected explicitly;
// Node byte/brand/record conversion remains a host control, never guest JSAPI.
const fs=require('node:fs'),path=require('node:path'),util=require('node:util'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
const bundle=fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
const factory=Function(bundle+';return {values:_createNodeValuesPlatform,digest:_createNodeCryptoDigest};')();
const nativeHash=crypto.hash,nativeGetHashes=crypto.getHashes,nativeEqual=crypto.timingSafeEqual;
function bytes(value) {
  if (typeof value==='string') return Buffer.from(value);
  if (util.types.isArrayBufferView(value)) return Buffer.from(value.buffer,value.byteOffset,value.byteLength);
  return Buffer.from(value);
}
exports.create=function create() {
  const warnings=[];
  const processControl={ platform:process.platform,emitWarning(...args){warnings.push(args);} };
  const values=factory.values({process:processControl,Buffer,util,inspection:util,os:require('node:os'),
    signals:require('node:os').constants.signals,getDOMException:()=>DOMException});
  const helper=process.env.KANDELO_CRYPTO_NATIVE_HELPER;
  // The unchanged XOF test produces 1 MiB of bytes, serialized as 2 MiB hex.
  // This bounds the fixture transport, not the guest digest or test assertion.
  const run=(args,input)=>JSON.parse(execFileSync(helper,args,{input,encoding:'utf8',timeout:5000,maxBuffer:16*1024*1024}));
  const native={
    hashDigest(algorithm,input,length,options) {
      if (helper) {
        const result=run([algorithm,length===undefined?'-':`${length}`,options?'1':'0'],bytes(input));
        return result.hex===undefined?result:new Uint8Array(Buffer.from(result.hex,'hex'));
      }
      try {return nativeHash(algorithm,input,{outputEncoding:'buffer',outputLength:length,...options?{functionName:''}:{}});}
      catch(e) {return Object.assign({message:e.message},e);}
    },
    digestNames(){return helper?run(['names']):nativeGetHashes();},
    timingSafeEqual(a,b) {
      const valid=v=>util.types.isAnyArrayBuffer(v)||util.types.isArrayBufferView(v);
      if (!valid(a)) return 1;if (!valid(b)) return 2;
      const first=bytes(a),second=bytes(b);if(first.length!==second.length)return 3;
      return helper?run(['equal',first.toString('hex'),second.toString('hex')]):nativeEqual(a,b);
    },
  };
  return {...factory.digest({values,Buffer,types:util.types,native}),warnings};
};
