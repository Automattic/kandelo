import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {afterEach,describe,expect,it} from 'vitest';
import {createRequire} from 'node:module';
const {createDnsPlatform}=createRequire(import.meta.url)('./fixtures/node-dns-platform.cjs');
const addressRulesPlatform=createRequire(import.meta.url)('./fixtures/node-address-rules-platform.cjs');
const dnsCleanups:Array<()=>void>=[];
afterEach(()=>{for(const close of dnsCleanups.splice(0))close();});
import {inspect,types} from 'node:util';
import {nodeSocketTimeoutCases} from './fixtures/node-socket-timeouts';
import {createDiagnosticsPlatform} from './fixtures/node-diagnostics-platform';
import * as nativeStreams from 'node:stream';
import {createNativeTaskBoundary} from './fixtures/node-native-tasks';
import {AsyncLocalStorage} from 'node:async_hooks';
const bootstrap=readFileSync(new URL('../../packages/registry/node-compat/bootstrap.js',import.meta.url),'utf8');
const adapter=readFileSync(new URL('../../packages/registry/spidermonkey/node-compat/adapter.js',import.meta.url),'utf8');
const target=JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json',import.meta.url),'utf8'));
function section(source:string,start:string,end:string){const a=source.indexOf(start),b=source.indexOf(end,a);if(a<0||b<0)throw Error('Missing socket timeout source boundary');return source.slice(a,b);}
function subject(){
 const dnsContext=createDnsPlatform();dnsCleanups.push(dnsContext.close);
 let time=0,remaining=0;const warnings:Array<[string,string]>=[];
 const make=Function('native','runWithAsyncContext',section(adapter,'function createTimerScheduler(now)','const timerScheduler =')+';return createTimerScheduler;')({getAsyncContext:()=>AsyncLocalStorage.snapshot()},(scope:Function,fn:Function,receiver:any,args:any[])=>scope(()=>Reflect.apply(fn,receiver,args)));
 const scheduler=make(()=>time);
 const os={setTimeout:(fn:Function,delay:number,ref:boolean,start:number)=>scheduler.schedule(fn,delay,ref,false,start),clearTimeout:scheduler.clear,timerRef:scheduler.ref,timerNow:scheduler.now};
 const process={nextTick:globalThis.process.nextTick.bind(globalThis.process),emitWarning:(message:string,name:string)=>warnings.push([message,name])};
 const timers=Function('os','process','_nodeAsyncPlatform',section(bootstrap,'const timers = (() => {','const _nodeRemovalPlatform =')+';return timers;')(os,process,createNativeTaskBoundary());
 const native={...addressRulesPlatform.native,...dnsContext.native,isNativeError:types.isNativeError,socketAddress:()=>({address:'127.0.0.1',family:'IPv4',port:123}),socketClose(){},socketWrite:()=>new Promise(()=>{}),socketWriteQueueSize:()=>remaining,socketRef(){}};
 // Native streams isolate Socket timeout policy; the full shared stream
 // dependency graph and guest descriptor loop require later integration runs.
 const diagnostics=createDiagnosticsPlatform();
 const net=Function('_nodeNative','Buffer','util','timers','process','_nodeDiagnostics','_nodeStreamPlatform','_nodeValues','_createNodeNetworkIP','_createNodeDnsLookupPlatform','_createNodePerformanceObserverPlatform','_nodeAsyncPlatform','_nodeWebPlatform','_createNodeAddressRules','_nodeClonePlatform','_nodeInspection','_nodeEventPlatform',section(bootstrap,'function _errnoToCode(','function _checkErrno(')+section(bootstrap,'const events =','// events.setMaxListeners')+section(bootstrap,'const stream =','const _nodePortIO =')+section(bootstrap,'const _nodeNetworkIP =','// tls module')+';return net;')(native,Buffer,{inspect},timers,process,diagnostics,{api:nativeStreams},dnsContext.values,dnsContext.factories.ip,dnsContext.factories.dns,dnsContext.factories.perf,{api:{asyncWrapProviders:dnsContext.asyncProviders}},dnsContext.web,addressRulesPlatform.factories.address,addressRulesPlatform.clone,{inspect},dnsContext.event);
 return {net,timers,warnings,scheduler,advance(value:number){time=value;scheduler.runOne();},queue(value:number){remaining=value;}};
}
describe('actual socket timeout source and scheduler',()=>{
 it('binds handle metadata to the actual owned fd and retires old handles',()=>{const s=subject(),socket=new s.net.Socket();expect(socket._handle).toBe(null);socket._adoptFd(4);const handle=socket._handle;expect(handle.fd).toBe(4);s.queue(20);expect(handle.writeQueueSize).toBe(20);socket.destroy();expect(socket._handle).toBe(null);expect(handle.fd).toBe(-1);expect(handle.writeQueueSize).toBe(0);});
 it('does not reference the event loop and cancels the previous deadline',()=>{const s=subject(),socket=new s.net.Socket();let n=0;socket.setTimeout(10,()=>n++);expect(s.scheduler.hasReferences()).toBe(false);socket.setTimeout(0);s.advance(20);expect(n).toBe(0);expect(s.scheduler.nextDelay()).toBe(null);});
 it('refreshes read/write inactivity from the current monotonic instant',()=>{const s=subject(),socket=new s.net.Socket();let n=0;socket.setTimeout(10,()=>n++);s.advance(5);socket._unrefTimer();s.advance(10);expect(n).toBe(0);s.advance(15);expect(n).toBe(1);socket._unrefTimer();s.advance(25);expect(n).toBe(1);});
 it('distinguishes progress from a stalled pending native write',()=>{const s=subject(),socket=new s.net.Socket();socket._adoptFd(4);let n=0;socket.setTimeout(10,()=>n++);s.queue(100);socket._write(Buffer.alloc(100),'buffer',()=>{});s.queue(80);s.advance(10);expect(n).toBe(0);s.advance(20);expect(n).toBe(1);socket.destroy();});
 it('cancels its deadline on destroy and ignores later setTimeout calls',()=>{const s=subject(),socket=new s.net.Socket();socket.setTimeout(10,()=>{throw Error('destroyed timeout fired');});socket.destroy();expect(socket.setTimeout('bad',null)).toBe(socket);s.advance(20);expect(s.scheduler.nextDelay()).toBe(null);});
 it('caps socket overflow at the maximum duration with the target warning',()=>{const s=subject(),socket=new s.net.Socket();socket.setTimeout(2147483648);expect(socket.timeout).toBe(2147483648);expect(s.scheduler.nextDelay()).toBe(2147483647);expect(s.warnings).toEqual([['2147483648 does not fit into a 32-bit signed integer.\nTimer duration was truncated to 2147483647.','TimeoutOverflowWarning']]);socket.setTimeout(0);});
});
describe.skipIf(process.versions.node!==target.version)('exact native public socket timeout controls',()=>{for(const c of nodeSocketTimeoutCases)it(c.name,()=>{const r=spawnSync(process.execPath,['-e',c.source],{encoding:'utf8',timeout:5000});expect(r.error).toBeUndefined();expect(r.status,r.stderr).toBe(0);expect(r.stdout.trim()).toBe(`node-socket-timeouts-${c.name}-ok`);},7000);});
