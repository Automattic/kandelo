'use strict';
// Exact candidate cipher wrappers/private codecs; native key/stream dependencies
// and DER transport into actual portable material are explicit component bounds.
const fs=require('node:fs'),path=require('node:path'),util=require('node:util'),crypto=require('node:crypto');
const saved=['internalBinding','primordials'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]);
const raw=require('internal/test/binding').internalBinding('crypto');
for(const [k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k]}
const methods=Object.fromEntries(['export','getKeyType'].map(k=>[k,raw.KeyObjectHandle.prototype[k]]));
const component=require(process.env.RSA_COMPONENT);
const source=fs.readFileSync(path.resolve(__dirname,'../../node-core.js'),'utf8');
const factories=Function(source+';return{values:_createNodeValuesPlatform,digest:_createNodeCryptoDigest,cipher:_createNodeCipherPlatform};')();
exports.create=function(){
 const storage=require('../../../../host/test/fixtures/node-buffer-codecs.cjs').create();
 const values=factories.values({process,Buffer:storage.Buffer,util,inspection:util,os:require('node:os'),signals:require('node:os').constants.signals,getDOMException:()=>DOMException});
 let helpers;factories.digest({values,Buffer:storage.Buffer,types:util.types,native:{},captureHelpers(v){helpers=v}});
 function nativeOperation(operation,...args){
  if(operation==='constants')return{value:crypto.constants};
  if(operation!=='rsa')throw Error('Unexpected unrelated cipher component call '+operation);
  // The production path retains actual private engine material directly.
  // This N-API test projects genuine native key material through DER because
  // it cannot borrow Node's private KeyObjectHandle C++ representation.
  if(args[1] instanceof raw.KeyObjectHandle){
   const role=Reflect.apply(methods.getKeyType,args[1],[]);
   args[1]=Reflect.apply(methods.export,args[1],role===raw.kKeyTypePrivate?[raw.kKeyFormatDER,raw.kKeyEncodingPKCS8,undefined,undefined]:[raw.kKeyFormatDER,raw.kKeyEncodingSPKI]);
   args[2]=raw.kKeyFormatDER;args[3]=role===raw.kKeyTypePrivate?raw.kKeyEncodingPKCS8:raw.kKeyEncodingSPKI;
  }else if(args[2]===raw.kKeyFormatJWK){
   const key=args[1],privateKey=Object.hasOwn(key,'d');
   args[1]=(privateKey?crypto.createPrivateKey({key,format:'jwk'}):crypto.createPublicKey({key,format:'jwk'})).export({format:'der',type:privateKey?'pkcs8':'spki'});
   args[2]=raw.kKeyFormatDER;args[3]=privateKey?raw.kKeyEncodingPKCS8:raw.kKeyEncodingSPKI;
  }
  for(const n of [1,4,6,9])if(util.types.isSharedArrayBuffer(args[n]))args[n]=new Uint8Array(args[n]);
  return component.operation(...args);
 }
 const api=factories.cipher({native:{cipherOperation:nativeOperation},values,codecs:storage.codecs,types:util.types,keys:require('internal/crypto/keys'),digestHelpers:helpers,kHandle:Symbol('kHandle'),stringDecoder:require('node:string_decoder'),streams:{require:require}});
 return{...api,Buffer:storage.Buffer};
};
