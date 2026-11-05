import { createRequire } from 'node:module';
import * as native from 'node:os';
import { describe, expect, it } from 'vitest';
const require=createRequire(import.meta.url),fixture=require('./fixtures/node-os-platform.cjs');
const target=require('../../packages/registry/node-compat/target.json');
function failure(fn:()=>unknown){try{fn();}catch(e:any){return{name:e.name,code:e.code,message:e.message,info:e.info};}}
function env(values:Record<string,string|undefined>,fn:()=>unknown){const previous=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));
 try{for(const [k,v]of Object.entries(values)){if(v===undefined)delete process.env[k];else process.env[k]=v;}return fn();}
 finally{for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}}
describe.skipIf(process.versions.node!==target.version)('pinned OS frontend and actual POSIX state owners',()=>{
 it('matches frontend exports, descriptors, aliases and actual uname/hostname/endianness values',()=>{
  const owner=fixture.create(),api=owner.api,expected=require('node:os');
  expect(owner.boundary).toBe(process.env.KANDELO_OS_NATIVE_HELPER?'compiled portable POSIX owner':'native Node OS dependency control');
  expect(Object.keys(api)).toEqual(Object.keys(expected));
  for(const name of ['type','version','release','machine','hostname','endianness','arch','platform']){
   expect(api[name](),name).toBe(expected[name]());
   if(name!=='hostname')expect(String(api[name])).toBe(String(expected[name]));
  }
  for(const name of ['constants','EOL','devNull']){
   const a=Object.getOwnPropertyDescriptor(api,name)!,b=Object.getOwnPropertyDescriptor(expected,name)!;
   expect([a.enumerable,a.configurable,a.writable]).toEqual([b.enumerable,b.configurable,b.writable]);expect(a.value).toBe(b.value);
  }
  const existing={constants:{}};expect(owner.install(existing)).toBe(existing);expect((existing as any).homedir).toBe(api.homedir);
 });
 it('uses actual HOME including empty strings, then passwd home when absent',()=>{
  const {api}=fixture.create();for(const HOME of ['/control/home/','',undefined])
   env({HOME},()=>expect(api.homedir()).toBe(native.homedir()));
  env({HOME:'/'+ 'a'.repeat(8192)},()=>expect(failure(()=>api.homedir())).toEqual(failure(()=>native.homedir())));
 });
 it('follows safe temp-variable precedence, empty handling and single slash stripping',()=>{
  const {api}=fixture.create();for(const values of [
   {TMPDIR:'/a//',TMP:'/b',TEMP:'/c'}, {TMPDIR:'',TMP:'/b/',TEMP:'/c'},
   {TMPDIR:undefined,TMP:'',TEMP:'/'}, {TMPDIR:undefined,TMP:undefined,TEMP:undefined}])
    env(values,()=>expect(api.tmpdir()).toBe(native.tmpdir()));
 });
 it('copies actual passwd records with target encodings, null prototypes and getter errors',()=>{
  const {api}=fixture.create();
  for(const encoding of [undefined,'utf8','utf-8','latin1','ascii','hex','base64','base64url','utf16le','buffer','BUFFER','buffer\0ignored','unknown',1,Symbol('encoding'),{get length(){throw Error('must not inspect encoding objects');}}]){
   const actual=api.userInfo({encoding}),expected=native.userInfo({encoding:encoding as any});
   expect(Object.getPrototypeOf(actual)).toBe(null);expect(actual).toEqual(expected);
  }
  const sentinel=Error('encoding getter');expect(()=>api.userInfo({get encoding(){throw sentinel;}})).toThrow(sentinel);
 });
 it('preserves priority validation and actual errno-based SystemError information',()=>{
  const {api,calls}=fixture.create();const before=calls.length;
  for(const args of [[null],['0'],[1.5],[NaN],[2147483648]])
   expect(failure(()=>api.getPriority(...args))).toEqual(failure(()=>(native.getPriority as any)(...args)));
  for(const args of [[],[null],['0'],[20],[-21],[0,20],[0,1.5]])
   expect(failure(()=>api.setPriority(...args))).toEqual(failure(()=>(native.setPriority as any)(...args)));
  expect(calls).toHaveLength(before);
  expect(api.getPriority()).toBe(native.getPriority());
  expect(api.setPriority(0,native.getPriority())).toBeUndefined();
  expect(failure(()=>api.getPriority(2147483647))).toEqual(failure(()=>native.getPriority(2147483647)));
  expect(failure(()=>api.setPriority(2147483647,0))).toEqual(failure(()=>native.setPriority(2147483647,0)));
 });
 it('uses private byte/string owners despite public candidate Buffer method replacement',()=>{
  const byte=require('./fixtures/node-buffer-codecs.cjs').create();
  const {api}=fixture.create({Buffer:byte.Buffer,codecs:byte.codecs});
  const expected={home:native.homedir(),hostname:native.hostname(),user:native.userInfo()};
  const ctor=Object.getOwnPropertyDescriptors(byte.Buffer),proto=Object.getOwnPropertyDescriptors(byte.Buffer.prototype);
  const poison=()=>{throw Error('public Buffer method must not be used');};
  try{
   byte.Buffer.from=poison;byte.Buffer.isEncoding=poison;
   byte.Buffer.prototype.toString=poison;byte.Buffer.prototype.utf8Slice=poison;byte.Buffer.prototype.ucs2Slice=poison;
   expect(api.homedir()).toBe(expected.home);expect(api.hostname()).toBe(expected.hostname);expect(api.userInfo()).toEqual(expected.user);
   for(const encoding of ['utf8','latin1','ascii','hex','base64','base64url','utf16le'])
    expect(api.userInfo({encoding})).toEqual(native.userInfo({encoding}));
   const raw=api.userInfo({encoding:'buffer'});expect(raw.username instanceof byte.Buffer).toBe(true);
   expect(Array.from(raw.username)).toEqual(Array.from(native.userInfo({encoding:'buffer'}).username));
  }finally{Object.defineProperties(byte.Buffer,ctor);Object.defineProperties(byte.Buffer.prototype,proto);}
 });
 it('reports missing measured backends explicitly rather than returning preset success',()=>{
  const {api}=fixture.create();for(const name of ['availableParallelism','cpus','freemem','totalmem','loadavg','networkInterfaces','uptime'])
   expect(failure(()=>api[name]())?.code,name).toBe('ERR_METHOD_NOT_IMPLEMENTED');
 });
});
