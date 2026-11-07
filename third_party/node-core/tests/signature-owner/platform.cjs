'use strict';
// Actual candidate wrappers over real portable signature owner. Native key
// parsing/DER export and Node Writable are explicit component dependencies.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),util=require('node:util');
const saved=['internalBinding','primordials'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]);
const raw=require('internal/test/binding').internalBinding('crypto');
for(const [k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k]}
const methods=Object.fromEntries(['export','getKeyType'].map(k=>[k,raw.KeyObjectHandle.prototype[k]]));
const component=require(process.env.SIGNATURE_COMPONENT);
const source=fs.readFileSync(path.resolve(__dirname,'../../node-core.js'),'utf8');
const factories=Function(source+';return{values:_createNodeValuesPlatform,digest:_createNodeCryptoDigest,signature:_createNodeSignaturePlatform};')();
exports.create=function(){
 const storage=require('../../../../host/test/fixtures/node-buffer-codecs.cjs').create();
 const values=factories.values({process,Buffer:storage.Buffer,util,inspection:util,os:require('node:os'),signals:require('node:os').constants.signals,getDOMException:()=>DOMException});
 let helpers;factories.digest({values,Buffer:storage.Buffer,types:util.types,native:{},captureHelpers(v){helpers=v}});
 function signatureOperation(operation,...args){
  if(operation==='new'){
   const packet=component.operation(operation);if(packet.error===undefined)Object.setPrototypeOf(packet.value,args[0]);return packet;
  }
  if(operation==='update'&&typeof args[1]==='string')args[1]=storage.Buffer.from(args[1],args[2]);
  if(operation==='sign'||operation==='verify'){
   if(args[1] instanceof raw.KeyObjectHandle){
    const role=Reflect.apply(methods.getKeyType,args[1],[]);
    args[1]=Reflect.apply(methods.export,args[1],role===raw.kKeyTypePrivate?[raw.kKeyFormatDER,raw.kKeyEncodingPKCS8,undefined,undefined]:[raw.kKeyFormatDER,raw.kKeyEncodingSPKI]);
    args[2]=raw.kKeyFormatDER;args[3]=role===raw.kKeyTypePrivate?raw.kKeyEncodingPKCS8:raw.kKeyEncodingSPKI;
   }else if(args[2]===raw.kKeyFormatJWK){
    const key=args[1],privateKey=Object.hasOwn(key,'d');
    args[1]=(privateKey?crypto.createPrivateKey({key,format:'jwk'}):crypto.createPublicKey({key,format:'jwk'})).export({format:'der',type:privateKey?'pkcs8':'spki'});
    args[2]=raw.kKeyFormatDER;args[3]=privateKey?raw.kKeyEncodingPKCS8:raw.kKeyEncodingSPKI;
   }
  }
  for(const n of [1,4,6])if(util.types.isSharedArrayBuffer(args[n]))args[n]=new Uint8Array(args[n]);
  return component.operation(operation,...args);
 }
 return factories.signature({native:{signatureOperation},values,Buffer:storage.Buffer,types:util.types,codecs:storage.codecs,keys:require('internal/crypto/keys'),digestHelpers:helpers,kHandle:Symbol('kHandle'),streams:require('node:stream'),constants:{crypto:crypto.constants}});
};
