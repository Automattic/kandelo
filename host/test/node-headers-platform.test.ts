import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createWebDataPlatform } from './fixtures/node-web-data-platform';
const target=JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json',import.meta.url),'utf8'));
const bootstrap=readFileSync(new URL('../../packages/registry/node-compat/bootstrap.js',import.meta.url),'utf8');
function failure(fn:()=>unknown){try{fn();}catch(e:any){return{name:e.name,code:e.code,message:e.message};}}
function section(start:string,end:string){const a=bootstrap.indexOf(start),b=bootstrap.indexOf(end,a);if(a<0||b<a)throw Error('Missing Fetch source boundary');return bootstrap.slice(a,b);}
function fetchControl() {
 const owner=createWebDataPlatform();
 const vendor=readFileSync(new URL('../../third_party/node-web-platform/node-web-platform.js',import.meta.url),'utf8');
 const web=Function(vendor+';return _createNodeWebPlatform();')();
 const body=Function('_nodeWebPlatform','_nodeClonePlatform',section('const _nodeBodyData =',"if (typeof globalThis.Blob === 'undefined')")+';return _nodeBodyData;')(web,owner.cloneOwner);
 let requestOptions:any;
 // Only the HTTP transport boundary is controlled. The actual Fetch source
 // consumes candidate Headers, builds its request and owns response guards.
 const http={request(options:any,callback:Function){requestOptions=options;const req=new EventEmitter() as any;
  req.write=()=>true;req.destroy=()=>{};req.end=()=>{
   const response=new EventEmitter() as any;response.statusCode=204;response.statusMessage='No Content';
   response.headers={'Set-Cookie':['a=1','b=2'],'X-Response':'value'};response.destroy=()=>{};callback(response);
  };return req;}};
 const api=Function('_nodeWebPlatform','_nodeBodyData','_nodeNative','_nodeFormDataPlatform','_nodeClonePlatform','http','https',
  section('    const FetchHeaders =','    globalThis.fetch = fetch;')+';return {Headers:FetchHeaders,Request:FetchRequest,Response:FetchResponse,fetch};')(
   web,body,{cloneValue:structuredClone},{headers:owner.headerInternals},owner.cloneOwner,http,http);
 return {...api,headerInternals:owner.headerInternals,get requestOptions(){return requestOptions;}};
}
describe.skipIf(process.versions.node!==target.version)('pinned Headers shared WebIDL and Fetch ownership',()=>{
 it('matches public descriptors, brands, iterator aliases and inspection',()=>{
  const {Headers:H}=createWebDataPlatform();
  expect(Reflect.ownKeys(H.prototype).map(String)).toEqual(Reflect.ownKeys(Headers.prototype).map(String));
  for(const key of Reflect.ownKeys(H.prototype)){
   const a=Object.getOwnPropertyDescriptor(H.prototype,key)!,b=Object.getOwnPropertyDescriptor(Headers.prototype,key)!;
   expect([a.enumerable,a.configurable,a.writable,typeof a.get,typeof a.value==='function'?a.value.length:undefined])
    .toEqual([b.enumerable,b.configurable,b.writable,typeof b.get,typeof b.value==='function'?b.value.length:undefined]);
  }
  expect(H.prototype.entries).toBe(H.prototype[Symbol.iterator]);
  expect(inspect(new H({'X-Name':'one','__proto__':'ignored literal'}))).toEqual(inspect(new Headers({'X-Name':'one','__proto__':'ignored literal'})));
  for(const receiver of [null,{},Object.create(H.prototype)])for(const method of ['append','delete','get','getSetCookie','has','set','entries'])
   expect(failure(()=>H.prototype[method].call(receiver,'name','value'))).toEqual(failure(()=>(Headers.prototype as any)[method].call(receiver,'name','value')));
 });
 it('matches constructor conversion ordering and preserves abrupt iterator/getter failures',()=>{
  const {Headers:H}=createWebDataPlatform();
  function run(C:any){const calls:string[]=[];const sentinel=Error('coercion');const input={
   get [Symbol.iterator](){calls.push('iterator');return function*(){calls.push('iterate');yield [{toString(){calls.push('name');return 'X-Name';}},{toString(){calls.push('value');return ' value ';}}];};}
  };
  const entries=[...new C(input)];const poison={get [Symbol.iterator](){throw sentinel;}};
  let same=false;try{new C(poison);}catch(e){same=e===sentinel;}
  return {calls,entries,same};}
  expect(run(H)).toEqual(run(Headers));
  for(const input of [null,1,'abc',[['one']],[[1,2,3]],{[Symbol.iterator]:1}])
   expect(failure(()=>new H(input))).toEqual(failure(()=>new Headers(input as any)));
 });
 it('matches byte-string, token and value validation across every byte and high Unicode',()=>{
  const {Headers:H}=createWebDataPlatform();
  for(let code=0;code<256;code++)for(const [name,value] of [['a'+String.fromCharCode(code)+'b','ok'],['name','a'+String.fromCharCode(code)+'b']]){
   expect(failure(()=>new H([[name,value]])),String(code)).toEqual(failure(()=>new Headers([[name,value]])));
  }
  for(const value of ['\u0100','\ud800',Symbol('value'),1n,null,undefined]){
   expect(failure(()=>new H([['name',value]]))).toEqual(failure(()=>new Headers([['name',value]] as any)));
  }
 });
 it('owns live sorted iteration, cookie separators and independent clone/cookie snapshots',()=>{
  const {Headers:H}=createWebDataPlatform();
  function run(C:any){const h=new C([['B','two'],['a','one'],['Cookie','a=1'],['cookie','b=2'],['Set-Cookie','first=1'],['set-cookie','second=2']]);
   const before=[...h],iterator=h.entries(),first=iterator.next();h.set('aaa','inserted');const second=iterator.next();
   const copy=new C(h),cookies=h.getSetCookie();cookies.push('detached');h.append('set-cookie','third=3');copy.delete('b');
   return {before,first,second,original:[...h],copy:[...copy],cookies:h.getSetCookie(),copied:copy.getSetCookie(),cookie:h.get('cookie')};}
  expect(run(H)).toEqual(run(Headers));
 });
 it('registers uncloneability and enforces actual private immutable guards',()=>{
  const owner=createWebDataPlatform(),h=new owner.Headers({name:'value'});
  expect(owner.modes.get(h)).toBe(0);
  expect(failure(()=>structuredClone(h))).toEqual(failure(()=>structuredClone(new Headers({name:'value'}))));
  owner.headerInternals.setHeadersGuard(h,'immutable');
  for(const [method,args] of [['set',['name','changed']],['append',['name','added']],['delete',['name']]] as const)
   expect(failure(()=>(h as any)[method](...args))).toEqual(failure(()=>(Response.error().headers as any)[method](...args)));
  expect(h.get('name')).toBe('value');
 });
 it('routes Fetch request headers through owned lists and preserves immutable response clones',async()=>{
  const api=fetchControl(),init=Object.create(null);init.__proto__='safe value';init['X-Name']=' value ';
  const headers=new api.Headers(init);
  // Preserve the exact target constructor-record behavior, then exercise an
  // actual legal header inserted through the public append path.
  expect([...headers]).toEqual([...new Headers(init)]);
  headers.append('__proto__','safe value');headers.append('Set-Cookie','a=1');headers.append('Set-Cookie','b=2');
  const request=new api.Request('http://control.invalid/path',{headers});
  expect(api.headerInternals.getHeadersGuard(request.headers)).toBe('request');
  const response=await api.fetch(request),sent=api.requestOptions.headers;
  expect(Object.getPrototypeOf(sent)).toBe(null);expect(sent.__proto__).toBe('safe value');
  expect(sent['x-name']).toBe('value');expect(sent['set-cookie']).toEqual(['a=1','b=2']);
  expect(response.headers).toBeInstanceOf(api.Headers);expect(response.headers.getSetCookie()).toEqual(['a=1','b=2']);
  expect(api.headerInternals.getHeadersGuard(response.headers)).toBe('immutable');
  expect(failure(()=>response.headers.set('x','y'))?.name).toBe('TypeError');
  const copy=response.clone();expect(api.headerInternals.getHeadersGuard(copy.headers)).toBe('immutable');
  expect(failure(()=>copy.headers.delete('x-response'))?.name).toBe('TypeError');
  expect(copy.headers.get('x-response')).toBe('value');
  const overrides={'X-Other':'override'};
  const rewritten=new api.Request(request,{headers:overrides});
  const reference=new Request(new Request('http://control.invalid/path',{headers:[...headers]}),{headers:overrides});
  expect([...rewritten.headers]).toEqual([...reference.headers]);
  await api.fetch(request,{headers:overrides});
  expect(Object.entries(api.requestOptions.headers)).toEqual([...reference.headers]);
  expect(Object.hasOwn(api.requestOptions.headers,'__proto__')).toBe(false);
  expect(Object.hasOwn(api.requestOptions.headers,'x-name')).toBe(false);
 });
});
