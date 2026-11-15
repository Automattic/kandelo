import { build } from 'esbuild';
import { parse } from '@babel/parser';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { byteSliceSource } from './byte-slice-source.mjs';
import { accessDiagnosticSource } from './access-diagnostic-source.mjs';
import { sparseForkSource } from './sparse-fork-source.mjs';
import { reuseUnmappedSource } from './reuse-unmapped-source.mjs';
import { metadataDiagnosticSource } from './metadata-diagnostic-source.mjs';
import { shortScalarSource } from './short-scalar-source.mjs';
import { retirementSource } from './retirement-source.mjs';

const root=resolve('.'), out=resolve(process.argv[2]);
const flags=process.argv.slice(3);
if(flags.some(arg=>!['--direct-clocks','--clock-renew-after-stat','--native-network','--pregrow-group','--byte-slices','--byte-slice-diagnostics','--syscall-diagnostics','--worker-profile-diagnostics','--access-diagnostics','--sparse-fork-backing','--reuse-unmapped-pages','--retire-generations','--metadata-diagnostics'].includes(arg)&&!/^--scratch-bytes=\d+$/.test(arg)&&!/^--short-scalars=(dataview|typed|both)$/.test(arg)&&!/^--short-records=(1|16|64|128)$/.test(arg))||new Set(flags).size!==flags.length)
  throw Error('usage: build.mjs OUTPUT [--pregrow-group] [--byte-slices] [--byte-slice-diagnostics] [--syscall-diagnostics] [--worker-profile-diagnostics] [--access-diagnostics] [--short-scalars=dataview|typed|both] [--short-records=1|16|64|128]');
const pregrowGroup=flags.includes('--pregrow-group'),byteSlices=flags.includes('--byte-slices');
const nativeNetwork=flags.includes('--native-network');
const directClocks=flags.includes('--direct-clocks'),clockRenewAfterStat=flags.includes('--clock-renew-after-stat');
if(clockRenewAfterStat&&!directClocks)throw Error('clock renewal requires explicit direct clocks');
const byteSliceDiagnostics=flags.includes('--byte-slice-diagnostics');
const syscallDiagnostics=flags.includes('--syscall-diagnostics');
const workerProfileDiagnostics=flags.includes('--worker-profile-diagnostics');
const accessDiagnostics=flags.includes('--access-diagnostics');
const metadataDiagnostics=flags.includes('--metadata-diagnostics');
const shortFlags=flags.filter(arg=>arg.startsWith('--short-scalars='));
if(shortFlags.length>1)throw Error('duplicate short scalar mode');
const shortScalars=shortFlags[0]?.split('=')[1];
const recordFlags=flags.filter(arg=>arg.startsWith('--short-records='));
if(recordFlags.length>1)throw Error('duplicate short record mode');
const shortRecords=recordFlags.length?Number(recordFlags[0].split('=')[1]):undefined;
if(shortRecords&&(byteSlices||metadataDiagnostics||accessDiagnostics||byteSliceDiagnostics))throw Error('short records are screened independently from large-byte and counter factors');
if(shortScalars&&(byteSlices||shortRecords||metadataDiagnostics||accessDiagnostics))throw Error('short scalar factors are screened independently from byte-copy and span counters');
if(metadataDiagnostics&&byteSliceDiagnostics)throw Error('metadata and byte-slice diagnostics are separate first-stage profiles');
const sparseForkBacking=flags.includes('--sparse-fork-backing');
const reuseUnmappedPages=flags.includes('--reuse-unmapped-pages');
const retireGenerations=flags.includes('--retire-generations');
if(retireGenerations&&!reuseUnmappedPages)throw Error('generation retirement requires mapped-page ownership and sparse fork backing');
if(retireGenerations&&accessDiagnostics)throw Error('retirement stop/incarnation control and access diagnostics use incompatible root headers');
if(reuseUnmappedPages&&!sparseForkBacking)throw Error('unmapped reuse requires sparse fork backing to avoid orphan destination payload');
if(reuseUnmappedPages&&byteSlices)throw Error('unmapped reuse has not established byte-slice alias lifetime compatibility');
const scratchFlags=flags.filter(arg=>arg.startsWith('--scratch-bytes='));
if(scratchFlags.length>1)throw Error('duplicate scratch size');
const scratchBytes=scratchFlags.length?Number(scratchFlags[0].split('=')[1]):undefined;
if(scratchBytes!==undefined&&(!Number.isSafeInteger(scratchBytes)||scratchBytes<65536||scratchBytes>8*1024*1024||scratchBytes%65536))throw Error('scratch size must be whole 64KiB pages from 64KiB through 8MiB');
if(workerProfileDiagnostics&&!syscallDiagnostics)throw Error('worker profiles require syscall diagnostics for owner-clock phase snapshots');
if(byteSliceDiagnostics&&!byteSlices)throw Error('byte-slice diagnostics require byte-slices');
const shim=fileURLToPath(new URL('./memory.mjs',import.meta.url));
await mkdir(out,{recursive:true});
const inputs=new Map();
let clockRenewNumbers=[];
if(clockRenewAfterStat){
 const bytes=await readFile(resolve(root,'abi/snapshot.json'));
 const abi=JSON.parse(bytes);clockRenewNumbers=['Stat','Lstat','Fstat','Fstatat'].map(name=>{
  const entry=abi.syscalls.find(x=>x.name===name);if(!entry||!Number.isInteger(entry.number))throw Error('missing canonical metadata syscall '+name);return entry.number;
 });
 inputs.set('abi/snapshot.json',createHash('sha256').update(bytes).digest('hex'));
}

const imports={vmConstruct:'__kvmNew',vmCreateProcessMemory:'__kvmMemory',vmCopyFork:'__kvmFork',
  vmAtomics:'__kvmAtomics',vmIsSharedBuffer:'__kvmShared',vmIsMemory:'__kvmIsMemory',vmIsView:'__kvmIsView',
  vmBufferFrom:'__kvmBufferFrom',vmInstantiate:'__kvmInstantiate',vmCompile:'__kvmCompile',
  vmPostMessage:'__kvmPost',vmDecodeMessage:'__kvmDecode',vmApply:'__kvmApply',vmCall:'__kvmCall',
  vmReflectConstruct:'__kvmConstruct',vmIsVirtualMemory:'__kvmVirtual',vmInstanceOf:'__kvmInstance',vmIsVirtualBuffer:'__kvmVirtualBuffer',vmProgram:'__kvmProgram',vmTrackAnonymous:'__kvmTrackAnon',
  vmEnsureMapping:'__kvmEnsureMap',vmCommitMapping:'__kvmCommitMap',vmUnmap:'__kvmUnmap',vmAllocateBrowser:'__kvmBrowserAllocate',vmForkSnapshot:'__kvmForkSnapshot',vmGroupStats:'__kvmGroupStats'};
if(accessDiagnostics)imports.vmAccessCounts='__kvmAccessCounts';
const names=new Set(['Uint8Array','Int8Array','Uint8ClampedArray','Uint16Array','Int16Array',
  'Uint32Array','Int32Array','Float32Array','Float64Array','BigInt64Array','BigUint64Array','DataView','TextDecoder','TextEncoder']);
const identity=node=>node?.type==='TSNonNullExpression'?identity(node.expression):node?.type==='Identifier'?node.name:
  node?.type==='MemberExpression' && !node.computed?`${identity(node.object)}.${identity(node.property)}`:'';
const overrides={
  'host/src/node-kernel-host.ts:spawnKernelWorkerThread':'return new NodeThreadWorker(new URL("./node-kernel-worker-entry.mjs",import.meta.url));',
  'host/src/worker-adapter.ts:resolveCompiledEntry':'return new URL("./worker-entry.mjs",import.meta.url);',
};
function transform(source,path) {
  if(source.includes('__kvm')) throw Error(`reserved profile identifier in ${path}`);
  const tree=parse(source,{sourceType:'module',plugins:['typescript']});
  const edits=[];
  if(workerProfileDiagnostics && path==='host/src/node-kernel-worker-entry.ts')
    edits.push({start:tree.program.start,end:tree.program.start,text:'const __kvmCpuProfiles=new Map();\n'});
  const aliases=new Map();
  const replacements={'ArrayBuffer.isView':'__kvmIsView','Buffer.from':'__kvmBufferFrom',
    'WebAssembly.instantiate':'__kvmInstantiate','WebAssembly.compile':'__kvmCompile',
    'Reflect.apply':'__kvmApply','Reflect.construct':'__kvmConstruct'};
  // Intrinsic aliases are common in the host. Keep their native value but
  // adapt their use when the input belongs to the explicit virtual profile.
  function census(node) {
    if(!node || typeof node!=='object') return;
    if(node.type==='VariableDeclarator' && node.id.type==='Identifier' && node.init) {
      const rhs=identity(node.init);
      if(names.has(rhs) || rhs==='WebAssembly.Memory' || rhs==='WebAssembly.Instance') aliases.set(node.id.name,rhs);
      if(replacements[rhs]) aliases.set(node.id.name,rhs);
    }
    for(const value of Object.values(node)) {
      if(Array.isArray(value)) value.forEach(census);
      else if(value && typeof value==='object') census(value);
    }
  }
  census(tree.program);
  function edit(start,end,text) { edits.push({start,end,text}); }
  function visit(node,context='') {
    if(!node || typeof node!=='object' || !node.type) return;
    if(node.type==='ClassDeclaration' && ['NodeKernelHost','BrowserKernel'].includes(node.id?.name))
      edit(node.body.end-1,node.body.end-1,`\nasync commonMemoryPrototypeStats(){const requestId=this.${node.id.name==='NodeKernelHost'?'_nextRequestId':'nextRequestId'}++; return this.request(requestId,{type:"common_memory_prototype_stats",requestId});}\nasync commonMemoryPrototypeConnect(port,peerPort){const requestId=this.${node.id.name==='NodeKernelHost'?'_nextRequestId':'nextRequestId'}++; return this.request(requestId,{type:"common_memory_prototype_connect",requestId,port,peerPort});}\n`);
    if(accessDiagnostics && node.type==='ClassDeclaration' && ['NodeKernelHost','BrowserKernel'].includes(node.id?.name))
      edit(node.body.end-1,node.body.end-1,`\nasync commonMemoryPrototypeAccessCounts(){const requestId=this.${node.id.name==='NodeKernelHost'?'_nextRequestId':'nextRequestId'}++;return this.request(requestId,{type:"common_memory_prototype_access_counts",requestId});}\n`);
    if(syscallDiagnostics && node.type==='ClassDeclaration' && node.id?.name==='NodeKernelHost')
      edit(node.body.end-1,node.body.end-1,`\nasync commonMemoryPrototypeSyscallProfile(){const requestId=this._nextRequestId++;return this.request(requestId,{type:"common_memory_prototype_syscall_profile",requestId});}\n`);
    if(workerProfileDiagnostics && node.type==='ClassDeclaration' && node.id?.name==='NodeKernelHost')
      edit(node.body.end-1,node.body.end-1,`\nasync commonMemoryPrototypeWorkerProfile(action,pids){const requestId=this._nextRequestId++;return this.request(requestId,{type:"common_memory_prototype_worker_profile",requestId,action,pids});}\n`);
    if(workerProfileDiagnostics && path==='host/src/worker-adapter.ts' && node.type==='ClassDeclaration' && node.id?.name==='NodeWorkerHandle')
      edit(node.body.end-1,node.body.end-1,'\ncommonMemoryPrototypeStartCpuProfile(){return this.worker.startCpuProfile();}\n');
    if(workerProfileDiagnostics && path==='host/src/deferred-worker-handle.ts' && node.type==='ClassDeclaration' && node.id?.name==='DeferredWorkerHandle')
      edit(node.body.end-1,node.body.end-1,'\ncommonMemoryPrototypeStartCpuProfile(){if(this.terminated||!this.worker)throw new Error("CPU profiling requires a live backing Worker");return this.worker.commonMemoryPrototypeStartCpuProfile();}\n');
    if(node.type==='SwitchStatement' && identity(node.discriminant)==='msg.type'
      && ['host/src/node-kernel-worker-entry.ts','host/src/browser-kernel-worker-entry.ts'].includes(path)) {
      const result='__kvmGroupStats([...processes.values()].map(p=>p.memory))';
      if(accessDiagnostics) {
        const accessResult='__kvmAccessCounts([...processes.entries()].map(([pid,p])=>[pid,p.memory]))';
        edit(node.cases[0].start,node.cases[0].start,`case "common_memory_prototype_access_counts": {try {${path.includes('/node-')?`post({type:"response",requestId:msg.requestId,result:${accessResult}})`:`respond(msg.requestId,${accessResult})`};}catch(error){respondError(msg.requestId,String(error));}break;}\n`);
      }
      edit(node.cases[0].start,node.cases[0].start,`case "common_memory_prototype_stats": { ${path.includes('/node-')?`post({type:"response",requestId:msg.requestId,result:${result}})`:`respond(msg.requestId,${result})`}; break; }\n`);
      // Keep selection and injection in one worker turn. A split pair of
      // main-thread RPCs can retain an fd that a starting FPM child closes.
      const connect='kernelWorker?kernelWorker.commonMemoryPrototypeConnect(msg.port,msg.peerPort):{target:null,recv:-1}';
      edit(node.cases[0].start,node.cases[0].start,`case "common_memory_prototype_connect": { ${path.includes('/node-')?`post({type:"response",requestId:msg.requestId,result:${connect}})`:`respond(msg.requestId,${connect})`}; break; }\n`);
      if(syscallDiagnostics && path==='host/src/node-kernel-worker-entry.ts')
        edit(node.cases[0].start,node.cases[0].start,`case "common_memory_prototype_syscall_profile": {try {post({type:"response",requestId:msg.requestId,result:kernelWorker.commonMemoryPrototypeSyscallProfile()});}catch(error){respondError(msg.requestId,String(error));}break;}\n`);
      if(workerProfileDiagnostics && path==='host/src/node-kernel-worker-entry.ts')
        edit(node.cases[0].start,node.cases[0].start,`case "common_memory_prototype_worker_profile": {void(async()=>{
          if(!Array.isArray(msg.pids)||msg.pids.length<1||msg.pids.length>24||new Set(msg.pids).size!==msg.pids.length||msg.pids.some(pid=>!Number.isSafeInteger(pid)||pid<1))throw new Error("invalid profile PID selection");
          if(!["start","stop"].includes(msg.action))throw new Error("invalid worker profile action");
          if(msg.action==="start"&&__kvmCpuProfiles.size)throw new Error("worker profiles already active");
          const profiles=await Promise.all(msg.pids.map(async pid=>{
            if(msg.action==="start") {
              const worker=processes.get(pid)?.worker;if(!worker)throw new Error("missing profile worker "+pid);
              const startBeforeNs=process.hrtime.bigint().toString();const handle=await worker.commonMemoryPrototypeStartCpuProfile();const startAfterNs=process.hrtime.bigint().toString();
              if(typeof handle?.stop!=="function")throw new Error("invalid CPU profile handle");
              __kvmCpuProfiles.set(pid,{worker,handle,startBeforeNs,startAfterNs});return {pid,startBeforeNs,startAfterNs};
            }
            const active=__kvmCpuProfiles.get(pid);if(!active)throw new Error("missing active worker profile "+pid);
            const sameWorker=processes.get(pid)?.worker===active.worker;const stopBeforeNs=process.hrtime.bigint().toString();
            try {const profile=await active.handle.stop();const stopAfterNs=process.hrtime.bigint().toString();return {pid,startBeforeNs:active.startBeforeNs,startAfterNs:active.startAfterNs,stopBeforeNs,stopAfterNs,sameWorker,profile};}
            finally {__kvmCpuProfiles.delete(pid);}
          }));
          post({type:"response",requestId:msg.requestId,result:{profiles,ownerClockNs:process.hrtime.bigint().toString()}});
        })().catch(error=>respondError(msg.requestId,String(error)));break;}\n`);
    }
    if(syscallDiagnostics && path==='host/src/kernel-worker.ts' && node.type==='ClassDeclaration' && node.id?.name==='CentralizedKernelWorker')
      edit(node.body.end-1,node.body.end-1,`\ncommonMemoryPrototypeSyscallProfile(){if(!this.profileData)throw new Error("syscall profiling disabled; set WASM_POSIX_PROFILE=1 before kernel creation");return {clockNs:process.hrtime.bigint().toString(),entries:[...this.profileData].map(([nr,data])=>({nr,...data}))};}\n`);
    if(path==='host/src/kernel-worker.ts' && node.type==='ClassDeclaration' && node.id?.name==='CentralizedKernelWorker')
      edit(node.body.end-1,node.body.end-1,`\ncommonMemoryPrototypeConnect(port,peerPort){
        if(!Number.isSafeInteger(port)||port<0||port>65535||!Number.isSafeInteger(peerPort)||peerPort<0||peerPort>65535) throw new RangeError("invalid prototype connection port");
        let result;
        this.#runImmediateKernelEntry("prototype connection admission",entry=>{
          const live=this.#pickListenerTargetWithinKernelEntry(port,entry);
          const target=live?{pid:live.pid,fd:live.fd}:null;
          const recv=target?entry.instance.exports.kernel_inject_connection(target.pid,target.fd,127,0,0,1,peerPort):-9;
          result={target,recv};
          if(recv>=0) entry.deferProtocolEffect(()=>{this.scheduleWakeBlockedRetries();return undefined;});
          return undefined;
        });
        if(result===undefined) throw new Error("prototype connection admission did not complete");
        return result;
      }\n`);
    if(node.type==='ObjectProperty' && !node.computed) context=node.key.name??context;
    if(['FunctionDeclaration','ClassMethod','ObjectMethod','FunctionExpression','ArrowFunctionExpression'].includes(node.type)) {
      const declared=node.id?.name??node.key?.name;
      context=declared??context;
      const replacement=declared?overrides[`${path}:${declared}`]:undefined;
      if(replacement) { edit(node.body.start+1,node.body.end-1,replacement); return; }
      if(path==='host/src/process-memory.ts' && declared==='copyForkAddressSpace')
        edit(node.body.start+1,node.body.start+1,'\nif (__kvmFork(destination,source)) return;\n');
      if(path==='host/src/worker-main.ts' && ['centralizedWorkerMain','centralizedThreadWorkerMain'].includes(declared))
        edit(node.body.start+1,node.body.start+1,'\ninitData = __kvmDecode(initData);\n');
      if(path==='host/src/process-snapshot-comparator.ts' && declared==='recordComparisonMemoryShape')
        edit(node.body.start+1,node.body.start+1,'\nif (__kvmVirtual(memory)) return; // no native comparator grant for virtual backing\n');
      if(path==='host/src/kernel-scratch.ts' && declared==='intrinsicWasmMemoryBuffer')
        edit(node.body.start+1,node.body.start+1,'\nif (__kvmVirtual(memory)) return memory.buffer;\n');
      if(path==='host/src/kernel-scratch.ts' && declared==='intrinsicBufferByteLength')
        edit(node.body.start+1,node.body.start+1,'\nif (__kvmVirtualBuffer(buffer)) return buffer.byteLength;\n');
      if(path==='host/src/constants.ts' && declared==='describeWasmArtifactPolicyFailures')
        edit(node.body.start+1,node.body.start+1,`\noptions={...options,experimentalCommonMemory:${JSON.stringify(retireGenerations?'prototype-v2':'prototype-v1')}};\n`);
      if(path==='host/src/kernel-worker.ts' && declared==='trackAnonymousSharedMapping')
        edit(node.body.start+1,node.body.start+1,'\nif (__kvmTrackAnon(channel.memory,mapAddr,origArgs[1],origArgs[2])) return;\n');
      if(path==='host/src/kernel-worker.ts' && declared==='ensureProcessMemoryCovers')
        edit(node.body.start+1,node.body.start+1,'\nif (__kvmEnsureMap(processMemory,syscallNr===SYS_BRK?"brk":syscallNr===SYS_MMAP?"mmap":"mremap",retVal,origArgs)) return;\n');
      if(path==='host/src/kernel-worker.ts' && declared==='completeChannel')
        edit(node.body.start+1,node.body.start+1,'\nif(errVal===0 && (retVal===0 || retVal===0n)) { if(syscallNr===SYS_MPROTECT) __kvmCommitMap(channel.memory,origArgs[0],origArgs[1],origArgs[2]); if(syscallNr===SYS_MUNMAP) __kvmUnmap(channel.memory,origArgs[0],origArgs[1]); }\n');
    }
    if(path==='host/src/kernel-worker.ts' && node.type==='IfStatement'
      && source.slice(node.test.start,node.test.end)==='syscallNr === SYS_MSYNC && retVal === 0')
      edit(node.start,node.start,'if(syscallNr===SYS_MMAP && retVal>0) __kvmCommitMap(channel.memory,retVal,origArgs[1],origArgs[2]);\n');
    if(path==='host/src/kernel-worker.ts' && node.type==='ExpressionStatement' && node.expression.type==='CallExpression') {
      const call=node.expression;
      if(identity(call.callee)==='this.cleanupSharedMappings' && identity(call.arguments[0])==='channel.pid')
        edit(node.end,node.end,`\n__kvmUnmap(channel.memory,${source.slice(call.arguments[1].start,call.arguments[1].end)},${source.slice(call.arguments[2].start,call.arguments[2].end)});`);
    }
    if(path==='host/src/kernel.ts' && node.type==='CatchClause' && ['host_proc_write_bytes','host_proc_read_bytes'].includes(context))
      edit(node.body.start+1,node.body.start+1,`\nconsole.error(${JSON.stringify(context+' virtual-profile transfer failure')},${node.param.name});\n`);
    if(node.type==='NewExpression') {
      const ctor=identity(node.callee), canonical=aliases.get(ctor)??ctor;
      if(path==='host/src/process-memory.ts' && context==='acquireAsynchronously' && ctor==='ArrayBuffer')
        edit(node.start,node.arguments[0].start,'__kvmForkSnapshot(source, ');
      if(names.has(canonical) || canonical==='WebAssembly.Instance' || canonical==='WebAssembly.Memory') {
        const end=node.arguments[0]?.start??node.end-1;
        const factory=path==='host/src/process-memory.ts' && ['createMemory','createProcessMemory'].includes(context) && ctor==='WebAssembly.Memory';
        edit(node.start,end,factory?'__kvmMemory(':`__kvmNew(${ctor}, `);
        if(factory) edit(node.end-1,node.end-1,`, ${context==='createMemory'?'request':'layout'}.commonMemoryPrototype===true${sparseForkBacking?`, ${context==='createMemory'?'request':'layout'}.commonMemoryFork===true`:''}`);
      }
    }
    if(node.type==='ObjectExpression') {
      if(['host/src/node-kernel-worker-entry.ts','host/src/browser-kernel-worker-entry.ts'].includes(path) && context==='createFreshProcessMemory'
        && node.properties.some(p=>p.key?.name==='initialPages'))
        edit(node.start+1,node.start+1,'commonMemoryPrototype: __kvmProgram(programBytes),');
      if(path==='host/src/process-memory.ts' && ['acquireForkMemoryClone','acquireForkClone'].includes(context)
        && node.properties.some(p=>p.key?.name==='initialPages'))
        edit(node.start+1,node.start+1,`commonMemoryPrototype: __kvmVirtual(parentMemory),${sparseForkBacking?'commonMemoryFork:true,':''}`);
    }
    // Match browser behavior: the protected in-kernel client owns this
    // experiment's connections; never publish its FPM port on the host LAN.
    if(!nativeNetwork && path==='host/src/kernel-worker.ts' && node.type==='AssignmentExpression' && node.left.type==='MemberExpression'
      && node.left.object.type==='ThisExpression' && node.left.property.name==='netModule' && identity(node.right)==='net')
      edit(node.right.start,node.right.end,'null');
    if(node.type==='CallExpression') {
      const callee=identity(node.callee);
      if(path==='host/src/browser-kernel-worker-entry.ts' && callee==='processMemoryFactory.allocate') {
        edit(node.start,node.arguments[0].start,'__kvmBrowserAllocate(processMemoryFactory, ');
      }
      const replacement=replacements[aliases.get(callee)];
      if(replacement) edit(node.callee.start,node.callee.end,replacement);
      if(node.callee.type==='MemberExpression' && !node.callee.computed && node.callee.property.name==='call'
        && /[Ii]ntrinsic|Getter/.test(identity(node.callee.object))) {
        edit(node.start,node.callee.object.start,'__kvmCall(');
        edit(node.callee.object.end,node.arguments[0]?.start??node.end-1,', ');
      }
      if(node.callee.type==='MemberExpression' && !node.callee.computed && node.callee.property.name==='postMessage') {
        edit(node.start,node.callee.object.start,'__kvmPost(');
        edit(node.callee.object.end,node.arguments[0]?.start??node.end-1,', ');
      }
    }
    if(node.type==='MemberExpression') {
      const member=identity(node);
      const replacement=member.startsWith('Atomics.')?member.replace('Atomics.','__kvmAtomics.'):replacements[member];
      if(replacement) edit(node.start,node.end,replacement);
    }
    if(node.type==='BinaryExpression' && node.operator==='instanceof') {
      const rhs=identity(node.right), canonical=aliases.get(rhs)??rhs;
      const name=canonical==='SharedArrayBuffer'?'__kvmShared':canonical==='WebAssembly.Memory'?'__kvmIsMemory':null;
      if(name) { edit(node.start,node.start,`${name}(`); edit(node.left.end,node.end,')'); }
      else if(names.has(canonical)) { edit(node.start,node.start,'__kvmInstance('); edit(node.left.end,node.end,`, ${rhs})`); }
    }
    for(const [key,value] of Object.entries(node)) {
      if(['loc','start','end','extra','comments','leadingComments','trailingComments','innerComments'].includes(key)) continue;
      if(Array.isArray(value)) for(const child of value) visit(child,context);
      else if(value && typeof value==='object') visit(value,context);
    }
  }
  visit(tree.program);
  edits.sort((a,b)=>b.start-a.start || b.end-a.end);
  let last=source.length;
  for(const e of edits) {
    if(e.end>last) throw Error(`overlapping profile edits at ${path}:${e.start}`);
    source=source.slice(0,e.start)+e.text+source.slice(e.end); last=e.start;
  }
  const prelude=`import {${Object.entries(imports).map(([name,alias])=>`${name} as ${alias}`).join(',')}} from ${JSON.stringify(shim)};\n`;
  return {contents:prelude+source,loader:'ts',resolveDir:dirname(resolve(root,path))};
}
const plugin={name:'explicit-common-memory-views',setup(builder){
  builder.onLoad({filter:/\/tools\/common-memory-program\/platform\/memory\.mjs$/},async args=>{
    let source=await readFile(args.path,'utf8');
    if(pregrowGroup) {
      // [RUNTIME-WORKAROUND: JSC-SHARED-MEMORY-GROW-INSTANCE-TEARDOWN]
      // Diagnostic profile: grow the bounded common backing before any
      // process binds an instance, avoiding positive shared growth while
      // a different process's Worker/instances can be destroyed.
      const before='new WebAssembly.Memory({ initial: 1024, maximum: maximumPages, shared: true })';
      if(source.split(before).length!==2)throw Error('expected exactly one common-group constructor');
      source=source.replace(before,'new WebAssembly.Memory({ initial: maximumPages, maximum: maximumPages, shared: true })');
    }
    if(shortScalars)source=shortScalarSource(source,{mode:shortScalars});
    if(byteSlices||shortRecords)source=byteSliceSource(source,{diagnostics:byteSliceDiagnostics});
    if(metadataDiagnostics)source=metadataDiagnosticSource(source);
    if(scratchBytes!==undefined) {
      const before='scratchBytes = 8*1024*1024';
      if(source.split(before).length!==2)throw Error('expected exactly one default scratch size');
      source=source.replace(before,`scratchBytes = ${scratchBytes}`);
    }
    if(accessDiagnostics)source=accessDiagnosticSource(source);
    if(sparseForkBacking)source=sparseForkSource(source);
    if(reuseUnmappedPages)source=reuseUnmappedSource(source);
    if(retireGenerations)source=retirementSource(source,{
      backingModule:resolve(root,'host/src/process-memory-backing.ts'),
      ownershipModule:resolve(root,'host/src/common-memory-page-ownership.ts'),
      accountingModule:resolve(root,'host/src/process-memory-accounting.ts'),
    });
    return {contents:source,loader:'js',resolveDir:dirname(args.path)};
  });
  builder.onLoad({filter:/\/tools\/common-memory-program\/platform\/byte-slices\.mjs$/},async args=>{
    if(!shortRecords)return;
    let source=await readFile(args.path,'utf8');
    const before='state.length<256||';
    if(source.split(before).length!==2)throw Error('expected one short-record length guard');
    source=source.replace(before,`state.length<${shortRecords}||state.length>255||`);
    return {contents:source,loader:'js',resolveDir:dirname(args.path)};
  });
  builder.onResolve({filter:/\?worker&url$/},args=>({path:args.path,namespace:'prototype-worker-url'}));
  builder.onLoad({filter:/.*/,namespace:'prototype-worker-url'},args=>({contents:`export default new URL(${JSON.stringify('./'+args.path.split('/').at(-1).replace('.ts?worker&url','.mjs'))},import.meta.url).href;`,loader:'js'}));
  builder.onLoad({filter:/\/host\/src\/.*\.ts$/},async args=>{
    let source=await readFile(args.path,'utf8');
    inputs.set(relative(root,args.path),createHash('sha256').update(source).digest('hex'));
    if(clockRenewAfterStat&&args.path.endsWith('/kernel-worker.ts')){
      source='import {vmIsVirtualMemory as vmClockHasFreshMappings} from '+JSON.stringify(shim)+';\n'+source;
      const once=(before,after)=>{if(source.split(before).length!==2)throw Error('clock renewal anchor mismatch: '+before);source=source.replace(before,after);};
      once('newClockRecord,retireClockRecord,publishClockRecord','newClockRecord,retireClockRecord,publishClockRecord,clockCertificateReader');
      once('nr!==ABI_SYSCALLS.ClockGettime||prepared.errVal','(nr!==ABI_SYSCALLS.ClockGettime'+clockRenewNumbers.map(n=>'&&nr!=='+n).join('')+')||prepared.errVal');
      once('    const v=new DataView(channel.memory.buffer,channel.channelOffset);',
        '    if(nr!==ABI_SYSCALLS.ClockGettime&&!vmClockHasFreshMappings(channel.memory))return; // Renewal requires fresh VM PTE rights checks.\n    const clockKey=nr===ABI_SYSCALLS.ClockGettime?{pointer:args[1],clockId:args[0]|0,format:0 as const}:clockCertificateReader(init)();\n    if(!clockKey)return;\n    const v=new DataView(channel.memory.buffer,channel.channelOffset);');
      once('publishClockRecord(this.#clockEpoch,epoch,init,args[1],args[0]|0,0);',
        'publishClockRecord(this.#clockEpoch,epoch,init,clockKey.pointer,clockKey.clockId,clockKey.format);');
    }
    // Its native constructor is serialized into a fresh realm with toString;
    // leave that self-contained function intact. The caller selects VM groups.
    if(args.path.endsWith('/browser-process-memory-factory.ts')) return {contents:source,loader:'ts'};
    if(args.path.endsWith('/browser-kernel-default-artifacts.ts')) return {contents:'export const browserKernelDefaultArtifactUrls={}; export function browserDefaultRootfsVfsUrl(){throw Error("prototype requires explicit kernel and image bytes");}',loader:'js'};
    if(args.path.endsWith('/experimental-direct-clock.ts'))return{contents:'export const EXPERIMENTAL_DIRECT_CLOCK_ENABLED='+directClocks+';',loader:'ts'};
    if(/\/fast-clock-(control|record|provider)\.ts$/.test(args.path))return{contents:source,loader:'ts'};
    if(args.path.endsWith('/fast-clock-output.ts'))return{contents:'export {vmClockOutput as prepareDirectClockOutput} from '+JSON.stringify(shim),loader:'js'};
    return transform(source,relative(root,args.path));
  });
}};
for(const entry of ['node-kernel-host','node-kernel-worker-entry','worker-entry']) {
  await build({entryPoints:[resolve('host/src',entry+'.ts')],bundle:true,platform:'node',format:'esm',target:'es2022',
    outfile:resolve(out,entry+'.mjs'),sourcemap:'inline',plugins:[plugin],logLevel:'warning',
    banner:{js:'import { createRequire as __profileCreateRequire } from "node:module"; const require=__profileCreateRequire(import.meta.url);'},
  });
}
for(const entry of ['browser-kernel-host','browser-kernel-worker-entry','worker-entry-browser']) {
  await build({entryPoints:[resolve('host/src',entry+'.ts')],bundle:true,platform:'browser',format:'esm',target:'es2022',
    outfile:resolve(out,entry+'.mjs'),sourcemap:'inline',plugins:[plugin],logLevel:'warning',
    define:{'import.meta.env.BASE_URL':'"/"','import.meta.env.DEV':'false'},
    external:['node:*','net','fs','fs/promises','path','url','util','crypto','https','http','stream','zlib','worker_threads','module','os'],
  });
}
inputs.set(relative(root,shim),createHash('sha256').update(await readFile(shim)).digest('hex'));
inputs.set(relative(root,fileURLToPath(import.meta.url)),createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'));
if(byteSlices||shortRecords)for(const name of ['byte-slices.mjs','byte-slice-source.mjs']) {
  const file=fileURLToPath(new URL(name,import.meta.url));
  inputs.set(relative(root,file),createHash('sha256').update(await readFile(file)).digest('hex'));
}
if(accessDiagnostics) {
  const file=fileURLToPath(new URL('access-diagnostic-source.mjs',import.meta.url));
  inputs.set(relative(root,file),createHash('sha256').update(await readFile(file)).digest('hex'));
}
if(metadataDiagnostics) {
  const file=fileURLToPath(new URL('metadata-diagnostic-source.mjs',import.meta.url));
  inputs.set(relative(root,file),createHash('sha256').update(await readFile(file)).digest('hex'));
}
if(shortScalars) {
  const file=fileURLToPath(new URL('short-scalar-source.mjs',import.meta.url));
  inputs.set(relative(root,file),createHash('sha256').update(await readFile(file)).digest('hex'));
}
if(sparseForkBacking) {
  const file=fileURLToPath(new URL('sparse-fork-source.mjs',import.meta.url));
  inputs.set(relative(root,file),createHash('sha256').update(await readFile(file)).digest('hex'));
}
if(reuseUnmappedPages) {
  const file=fileURLToPath(new URL('reuse-unmapped-source.mjs',import.meta.url));
  inputs.set(relative(root,file),createHash('sha256').update(await readFile(file)).digest('hex'));
}
if(retireGenerations) {
  const file=fileURLToPath(new URL('retirement-source.mjs',import.meta.url));
  inputs.set(relative(root,file),createHash('sha256').update(await readFile(file)).digest('hex'));
}
await writeFile(resolve(out,'profile-inputs.json'),JSON.stringify({scope:'experimental host view adaptation; normal source files unchanged',
  nodeNetworking:nativeNetwork?'normal-host-bridge':'internal-fixture-only',
  directClocks,clockRenewAfterStat:clockRenewAfterStat?{syscalls:clockRenewNumbers,scope:'VM only; fresh task/signal checks and PTE rights; no cached time or stat'}:false,
  ...(metadataDiagnostics?{metadataDiagnostics:'realm-method-counts-v1'}:{}),
  ...(shortScalars?{shortScalars}:{}),
  ...(shortRecords?{shortRecords:{minimum:shortRecords,maximum:255}}:{}),
  ...(scratchBytes!==undefined?{scratchBytes}:{}),
  ...(sparseForkBacking?{forkBacking:'unique-private-pages-v1'}:{}),
  ...(reuseUnmappedPages?{unmappedReuse:'tracked-roots-snapshot-pins-v1'}:{}),
  ...(retireGenerations?{generationRetirement:'final-alias-quiescence-snapshot-cancellation-v1'}:{}),
  groupInitialPages:pregrowGroup?'maximumPages':1024,...(byteSlices?{byteSlices:'pristine-byte-slice-v1'}:{}),
  ...(byteSliceDiagnostics?{byteSliceDiagnostics:true}:{}),...(syscallDiagnostics?{syscallDiagnostics:'node-profile-map-v1'}:{}),...(workerProfileDiagnostics?{workerProfileDiagnostics:'node-worker-cpu-v1'}:{}),...(accessDiagnostics?{accessDiagnostics:'physical-per-root-v1'}:{}),inputs:Object.fromEntries([...inputs].sort())},null,2)+'\n');
console.log(`Common-memory Node host profile: ${out}`);
