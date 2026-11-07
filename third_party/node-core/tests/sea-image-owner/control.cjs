'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../../..');
const {api,nativeBinding}=require('./platform.cjs')(root,process.env.SEA_IMAGE_COMPONENT);
const reference=require('node:sea');const results=[];
function group(name,fn){fn();results.push({name,pass:true});}
function descriptor(obj,key){const d=Object.getOwnPropertyDescriptor(obj,key);return d&&{enumerable:d.enumerable,configurable:d.configurable,writable:d.writable,kind:typeof d.value};}
function error(fn){try{return {returned:fn()};}catch(e){return{name:e.name,code:e.code,message:e.message,constructor:e.constructor.name,codeDescriptor:descriptor(e,'code'),messageDescriptor:descriptor(e,'message'),stackType:typeof e.stack};}}
group('real compiled image detector and native ordinary control',()=>{
 assert.equal(api.isSea(),false);assert.equal(reference.isSea(),false);assert.equal(api.isSea,nativeBinding.isSea);
 assert.deepEqual(Object.keys(nativeBinding),['isSea']); // No fabricated asset callbacks/table.
 const marker=Buffer.from('NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:0');const bytes=fs.readFileSync(process.env.SEA_IMAGE_COMPONENT);
 const first=bytes.indexOf(marker);assert.ok(first>=0);assert.equal(bytes.indexOf(marker,first+1),-1);
 assert.equal(bytes.includes(Buffer.from('NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:1')),false);
});
group('complete pinned public module properties/functions',()=>{
 assert.deepEqual(Object.keys(api),Object.keys(reference));
 for(const key of Object.keys(reference)){
  assert.deepEqual(descriptor(api,key),descriptor(reference,key));assert.equal(api[key].name,reference[key].name);assert.equal(api[key].length,reference[key].length);
  assert.deepEqual(descriptor(api[key],'name'),descriptor(reference[key],'name'));assert.deepEqual(descriptor(api[key],'length'),descriptor(reference[key],'length'));
  assert.equal(Object.hasOwn(api[key],'prototype'),Object.hasOwn(reference[key],'prototype'));
 }
});
group('isSea receiver/arguments/constructor admission',()=>{
 for(const receiver of [undefined,null,{},Symbol('receiver')])assert.equal(Reflect.apply(api.isSea,receiver,[{},'extra']),Reflect.apply(reference.isSea,receiver,[{},'extra']));
 assert.deepEqual(error(()=>Reflect.construct(api.isSea,[])),error(()=>Reflect.construct(reference.isSea,[])));
});
group('all invalid key primitives and ordinary errors',()=>{
 for(const key of [undefined,null,1,1n,false,Symbol('key'),{},[],new String('key')])for(const name of ['getRawAsset','getAsset','getAssetAsBlob'])
  assert.deepEqual(error(()=>api[name](key)),error(()=>reference[name](key)),name);
 for(const key of ['', 'foo','with\0nul','Unicode-☃','file:///asset'])for(const name of ['getRawAsset','getAsset','getAssetAsBlob'])
  assert.deepEqual(error(()=>api[name](key)),error(()=>reference[name](key)),name);
});
group('encoding validates before key and ordinary-image state',()=>{
 for(const key of [undefined,1,{},'foo'])for(const encoding of [undefined,null,1,1n,false,Symbol('encoding'),{},[],new String('utf8'),'utf8','not-a-real-label'])
  assert.deepEqual(error(()=>api.getAsset(key,encoding)),error(()=>reference.getAsset(key,encoding)));
});
group('no coercion of invalid arguments',()=>{
 let calls=0;const bad={[Symbol.toPrimitive](){calls++;throw Error('coerced');},toString(){calls++;throw Error('coerced');},valueOf(){calls++;throw Error('coerced');}};
 for(const name of ['getAsset','getRawAsset','getAssetAsBlob'])assert.deepEqual(error(()=>api[name](bad)),error(()=>reference[name](bad)));
 assert.deepEqual(error(()=>api.getAsset('key',bad)),error(()=>reference.getAsset('key',bad)));assert.equal(calls,0);
});
group('Blob options untouched before non-SEA error',()=>{
 let calls=0;const options=new Proxy({}, {get(){calls++;throw Error('options accessed');}});
 assert.deepEqual(error(()=>api.getAssetAsBlob('key',options)),error(()=>reference.getAssetAsBlob('key',options)));assert.equal(calls,0);
});
group('asset keys and regular public constructor errors',()=>{
 assert.deepEqual(error(()=>api.getAssetKeys()),error(()=>reference.getAssetKeys()));assert.deepEqual(error(()=>api.getAssetKeys({},'extra')),error(()=>reference.getAssetKeys({},'extra')));
 for(const name of ['getAsset','getRawAsset','getAssetAsBlob','getAssetKeys'])assert.deepEqual(error(()=>Reflect.construct(api[name],['key'])),error(()=>Reflect.construct(reference[name],['key'])));
});
group('public metadata cannot fabricate image state',()=>{
 const oldPath=process.execPath,oldArgv=process.argv[0];try{process.execPath='/tmp/looks-like-a-sea';process.argv[0]='SEA';assert.equal(api.isSea(),false);assert.equal(reference.isSea(),false);}finally{process.execPath=oldPath;process.argv[0]=oldArgv;}
 const saved=api.isSea;try{api.isSea=()=>true;assert.equal(error(()=>api.getAsset('key')).code,'ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION');}finally{api.isSea=saved;}
});
console.log(JSON.stringify({groups:results.length,failures:0,results,scope:'Actual pinned detector compiled in identified native component image; complete unchanged public ordinary algorithms over actual candidate errors/validators with native type/inspection dependencies;not guest JSAPI or positive SEA conformance'}));
