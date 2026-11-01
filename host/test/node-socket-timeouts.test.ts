import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {describe,expect,it} from 'vitest';
import {inspect,types} from 'node:util';
import {nodeSocketTimeoutCases} from './fixtures/node-socket-timeouts';
const bootstrap=readFileSync(new URL('../../packages/registry/node-compat/bootstrap.js',import.meta.url),'utf8');
const adapter=readFileSync(new URL('../../packages/registry/spidermonkey/node-compat/adapter.js',import.meta.url),'utf8');
const target=JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json',import.meta.url),'utf8'));
function section(source:string,start:string,end:string){const a=source.indexOf(start),b=source.indexOf(end,a);if(a<0||b<0)throw Error('Missing socket timeout source boundary');return source.slice(a,b);}
function subject(){
 let time=0,remaining=0;const warnings:Array<[string,string]>=[];
 const make=Function(section(adapter,'function createTimerScheduler(now)','const timerScheduler =')+';return createTimerScheduler;')();
 const scheduler=make(()=>time);
 const os={setTimeout:(fn:Function,delay:number,ref:boolean,start:number)=>scheduler.schedule(fn,delay,ref,false,start),clearTimeout:scheduler.clear,timerRef:scheduler.ref,timerNow:scheduler.now};
 const process={emitWarning:(message:string,name:string)=>warnings.push([message,name])};
 const timers=Function('os','process',section(bootstrap,'const timers = (() => {','const timersPromises =')+';return timers;')(os,process);
 const native={isNativeError:types.isNativeError,socketAddress:()=>({address:'127.0.0.1',family:'IPv4',port:123}),socketClose(){},socketWrite:()=>new Promise(()=>{}),socketWriteQueueSize:()=>remaining,socketRef(){}};
 const net=Function('_nodeNative','Buffer','util','timers','process',section(bootstrap,'function _errnoToCode(','function _checkErrno(')+section(bootstrap,'const events =','// events.setMaxListeners')+section(bootstrap,'const stream =','// url module')+section(bootstrap,'const _nodeDnsLookup =','// net.BlockList')+';return net;')(native,Buffer,{inspect},timers,process);
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
