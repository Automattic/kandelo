import {readFileSync} from 'node:fs';
import {MessageChannel} from 'node:worker_threads';
import {describe,expect,it,vi} from 'vitest';
import {NodeKernelHost} from '../src/node-kernel-host';
import {MemoryFileSystem} from '../src/vfs/memory-fs';
async function image() {
 const fs=MemoryFileSystem.create(new SharedArrayBuffer(16*1024*1024));
 for(const dir of ['/etc','/tmp','/root'])fs.mkdir(dir,0o755);
 fs.createFileWithOwner('/etc/hosts',0o644,0,0,new TextEncoder().encode('127.0.0.1 localhost\n'));
 return fs.saveImage();
}
function fixture() {return new Uint8Array(readFileSync(new URL('./fixtures/tcp-state-observation.wasm',import.meta.url))).buffer;}
async function pair() {
 const output={server:'',client:'',stderr:''};const decoder=new TextDecoder();
 const server=new NodeKernelHost({rootfsImage:await image(),maxPages:4096,remoteNetwork:{role:'host'},onStdout:(_,b)=>{output.server+=decoder.decode(b);},onStderr:(_,b)=>{output.stderr+=decoder.decode(b);}});
 const {port1,port2}=new MessageChannel();
 const client=new NodeKernelHost({rootfsImage:await image(),maxPages:4096,remoteNetwork:{role:'joiner',peer:{port:port2,maxPayload:32,maxControlBytes:65536}},onStdout:(_,b)=>{output.client+=decoder.decode(b);},onStderr:(_,b)=>{output.stderr+=decoder.decode(b);}});
 try {await server.init();await Promise.all([server.attachRemotePeer({port:port1,maxPayload:32,maxControlBytes:65536}),client.init()]);}
 catch(error){await Promise.all([server.destroy(),client.destroy()]);throw error;}
 return {server,client,output,close:()=>Promise.all([server.destroy(),client.destroy()])};
}
describe('ordinary guest TCP through dedicated Node kernel workers',()=>{
 it('preserves asynchronous connect, explicit bind, 256 KiB stream bytes, and half-close replies',async()=>{
  const p=await pair();
  try {
   const server=p.server.spawn(fixture(),['tcp-state-observation','server']);
   await vi.waitFor(async()=>expect((await p.client.remoteNetworkSnapshot()).tcpListeners.some(l=>l.port===18087)).toBe(true));
   const client=p.client.spawn(fixture(),['tcp-state-observation','client']);
   expect(await Promise.all([server,client])).toEqual([0,0]);
   expect(p.output.stderr).toBe(''); expect(p.output.server).toContain('accepted 10.89.0.2:18187');
   expect(p.output.server).toContain('server drained 256 KiB before FIN and replied');
   expect(p.output.client).toContain('nonblocking bound guest TCP sent 256 KiB, half-closed, and received reply then EOF');
  }finally{await p.close();}
 },60000);
 it('reports a peer-worker disconnect as ECONNRESET to the accepted guest socket',async()=>{
  const p=await pair();
  try {
   const server=p.server.spawn(fixture(),['tcp-state-observation','reset-server']);
   await vi.waitFor(async()=>expect((await p.client.remoteNetworkSnapshot()).tcpListeners.some(l=>l.port===18087)).toBe(true));
   const client=p.client.spawn(fixture(),['tcp-state-observation','reset-client']); void client.catch(()=>{});
   await vi.waitFor(()=>expect(p.output.client).toContain('reset client connected'));
   await vi.waitFor(()=>expect(p.output.server).toContain('accepted 10.89.0.2:'));
   await p.client.destroy();expect(await server).toBe(0);
   expect(p.output.server).toContain('accepted guest observes ECONNRESET');expect(p.output.stderr).toBe('');
  }finally{await p.close();}
 },60000);
});
