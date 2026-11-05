import { createRequire } from 'node:module';
import * as nativeQuery from 'node:querystring';
import { runInThisContext } from 'node:vm';
import * as nativeUtil from 'node:util';
import { describe, expect, it } from 'vitest';
const require=createRequire(import.meta.url),fixture=require('./fixtures/node-query-codecs-platform.cjs');
const target=require('../../packages/registry/node-compat/target.json');
const codecs=require('./fixtures/node-buffer-codecs.cjs');
function failure(fn:()=>unknown){try{fn();}catch(e:any){return{name:e.name,code:e.code,message:e.message};}}
function implementation(){const {Buffer}=codecs.create();const warnings:any[]=[];
 const owner=fixture.create({Buffer,process:{...process,emitWarning(...args:any[]){warnings.push(args);}}});
 return {...owner,Buffer,warnings,qs:owner.require('querystring')};}
describe.skipIf(process.versions.node!==target.version)('pinned query-string and Unicode codec owners',()=>{
 it('matches query exports, aliases, callable metadata and null dictionary parsing',()=>{
  const {qs}=implementation(),native=require('node:querystring');
  expect(Object.keys(qs)).toEqual(Object.keys(native));expect(qs.parse).toBe(qs.decode);expect(qs.stringify).toBe(qs.encode);
  for(const key of Object.keys(qs)){
   expect([qs[key].name,qs[key].length,Object.getOwnPropertyDescriptor(qs,key)]).toEqual(
    [native[key].name,native[key].length,{...Object.getOwnPropertyDescriptor(native,key),value:qs[key]}]);
  }
  for(const input of [undefined,null,false,true,0,1,{},[],'','&','=', 'constructor=a&toString=b&__proto__=c&constructor=d','a=1&a=2&&b']){
   const actual=qs.parse(input),expected=native.parse(input);expect(Object.getPrototypeOf(actual)).toBe(null);expect(actual).toEqual(expected);
  }
 });
 it('uses candidate Buffer byte/UTF-8 algorithms for tolerant malformed percent and plus decoding',()=>{
  const {qs,Buffer}=implementation();
  const inputs=['plain','a+b','%','%2','%GG','%2B+%20','%E2%98%83','%E2%82','%FF%FE','é%FF','%00x%0A','%F0%9F%92%A9', '\ud800%ff'];
  for(const input of inputs)for(const spaces of [false,true]){
   const result=qs.unescapeBuffer(input,spaces);expect(result instanceof Buffer).toBe(true);
   expect(Array.from(result)).toEqual(Array.from((nativeQuery as any).unescapeBuffer(input,spaces)));
   expect(qs.unescape(input,spaces)).toEqual((nativeQuery.unescape as any)(input,spaces));
   expect(qs.parse('x='+input)).toEqual(nativeQuery.parse('x='+input));
  }
 });
 it('matches separators, equality tokens, maxKeys and custom-decoder fallback/order',()=>{
  const {qs}=implementation();
  for(const options of [undefined,{maxKeys:1},{maxKeys:0},{maxKeys:-1},{maxKeys:Infinity},{maxKeys:NaN},{maxKeys:'2'}])
   expect(qs.parse('a=>one&&a=>two&&b=>three','&&','=>',options)).toEqual(nativeQuery.parse('a=>one&&a=>two&&b=>three','&&','=>',options as any));
  function run(api:any){const calls:string[]=[];const result=api.parse('a+b=x+y&bad=%GG&again=%FF','&','=',{
   decodeURIComponent(value:string){calls.push(value);if(value.includes('%'))throw Error('fall back');return 'decoded:'+value;}});
   return {calls,result};}
  expect(run(qs)).toEqual(run(nativeQuery));
 });
 it('honors replaceable public escape/unescape hooks without losing aliases or abrupt identity',()=>{
  const {qs}=implementation();
  function run(api:any){const oldEscape=api.escape,oldUnescape=api.unescape;const calls:any[]=[];
   try{api.escape=(value:any)=>{calls.push(['escape',value]);return 'e'+value;};api.unescape=(value:any)=>{calls.push(['unescape',value]);return 'u'+value;};
    return {encoded:api.stringify({a:['1','2'],b:null}),parsed:api.parse('a=one&b=two'),calls};
   }finally{api.escape=oldEscape;api.unescape=oldUnescape;}}
  expect(run(qs)).toEqual(run(require('node:querystring')));
  const sentinel=Error('encoder');expect(()=>qs.stringify({a:'x'},undefined,undefined,{encodeURIComponent(){throw sentinel;}})).toThrow(sentinel);
 });
 it('matches primitive coercion and exact legacy surrogate encoding/error policy',()=>{
  const {qs}=implementation();const native=require('node:querystring');
  for(const value of [{a:null,b:undefined,c:false,d:0,e:NaN,f:Infinity,g:1n,h:{toString(){return 'object';}},i:['x',null,2]},null,4])
   expect(qs.stringify(value)).toEqual(native.stringify(value));
  for(const input of ['é','\ud800','\ud800a','\udfffz','𩸽',Symbol('x'),null,1n])
   expect(failure(()=>qs.escape(input))).toEqual(failure(()=>native.escape(input)));
  expect(qs.escape('\ud800a')).toBe(native.escape('\ud800a'));
 });
 it('loads real punycode lazily once, preserving Unicode/code-point/Bootstring behavior and cache retry',()=>{
  const owner=implementation();expect(owner.warnings).toEqual([]);const actual=owner.require('punycode'),native=require('node:punycode');
  expect(owner.require('punycode')).toBe(actual);expect(owner.warnings).toHaveLength(1);expect(owner.warnings[0][2]).toBe('DEP0040');
  expect(Object.keys(actual)).toEqual(Object.keys(native));expect(actual.version).toBe(native.version);
  for(const input of ['bücher','mañana','日本語','𩸽','user@mañana。example','xn--maana-pta.example','\ud800']){
   for(const key of ['encode','decode','toASCII','toUnicode']){
    expect(failure(()=>actual[key](input))).toEqual(failure(()=>native[key](input)));
    if(!failure(()=>native[key](input)))expect(actual[key](input)).toBe(native[key](input));
   }
   expect(actual.ucs2.decode(input)).toEqual(native.ucs2.decode(input));expect(actual.ucs2.encode(actual.ucs2.decode(input))).toBe(native.ucs2.encode(native.ucs2.decode(input)));
  }
  const warningFailure=Error('warning'),processControl={...process,emitWarning(){throw warningFailure;}};
  const retry=fixture.create({process:processControl,isInsideNodeModules:()=>false});
  expect(()=>retry.require('punycode')).toThrow(warningFailure);processControl.emitWarning=()=>{};
  expect(retry.require('punycode').toASCII('mañana')).toBe('xn--maana-pta');
 });
 it('classifies actual saved-frame sources with bounded internal filtering and mixed path separators',()=>{
  const bootstrap='kandelo:control-bootstrap';
  function stack(sources:(string|null)[]){let frame:any=null;for(let i=sources.length-1;i>=0;i--)frame={source:sources[i],parent:frame};return frame;}
  for(const path of ['/a/node_modules/pkg/file.js','C:\\a\\node_modules\\pkg\\file.js','/a/node_modules\\pkg/file.js','C:\\a\\node_modules/pkg/file.js']){
   const limits:number[]=[];const method=fixture.originMethod((n:number)=>{limits.push(n);return stack([bootstrap,'node:internal',null,path]);},bootstrap);
   expect(method()).toBe(true);expect(limits).toEqual([11]);expect(method(2)).toBe(false);
  }
  const first=fixture.originMethod(()=>stack([bootstrap,'/app/main.js','/node_modules/deeper.js']),bootstrap);expect(first()).toBe(false);
  const missing=fixture.originMethod(undefined,bootstrap);expect(failure(()=>missing())?.code).toBe('ERR_NOT_IMPLEMENTED');
 });
 it('uses actual native source stacks for origin controls and honors dependency warning suppression',()=>{
  // Native getCallSites is only the saved-frame transport in this control.
  // The evaluated wrapper has a genuine engine script filename; guest frame
  // counting and SpiderMonkey source visibility remain unvalidated.
  const adapter=fixture.originMethod((count:number)=>{
   const sites=(nativeUtil as any).getCallSites(count+2).slice(1);let frame:any=null;
   for(let i=sites.length-1;i>=0;i--)frame={source:sites[i].scriptName,parent:frame};
   return {source:'control adapter',parent:frame};
  },undefined);
  // Direct classification first sees this test source, hence application.
  expect(adapter()).toBe(false);
  for(const filename of ['/app/origin-control.js','/deps/node_modules/pkg/origin-control.js','C:\\deps\\node_modules\\pkg\\origin-control.js']) {
   const invoke=runInThisContext('(method)=>method()',{filename});
   expect(invoke(adapter)).toBe(invoke(fixture.nativeOrigin()));
  }
  let calls=0;const warnings:any[]=[];const dependency=fixture.create({process:{...process,emitWarning(...args:any[]){warnings.push(args);}},isInsideNodeModules(){calls++;return true;}});
  dependency.require('punycode');dependency.require('punycode');expect(calls).toBe(1);expect(warnings).toEqual([]);
 });
});
