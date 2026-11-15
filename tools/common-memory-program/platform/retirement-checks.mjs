// Component contract checks. Browser callers run this in a disposable Worker;
// results contain numbers/strings only, never a memory, view or wire packet.
export async function runRetirementChecks(M,{untranslatedStartup}) {
  const PAGE=65536,group=new M.VirtualGroup(undefined,{maximumPages:1024,scratchBytes:PAGE});
  let checks=0; const cases=[];
  const ok=(value,label)=>{checks++;if(!value)throw Error(label);};
  const throws=(fn,label)=>{let caught=false;try{fn();}catch{caught=true;}ok(caught,label);};
  const retire=(memory,mode='quiescent')=>M.prepareProcessBackingRetirement(memory,mode)?.();
  const high=()=>new Uint32Array(group.memory.buffer,4096,3)[1];
  const untranslated=await WebAssembly.compile(untranslatedStartup),sentinel=new Uint32Array(group.memory.buffer,64,1);
  const nativeControl=new WebAssembly.Instance(untranslated,{env:{memory:group.memory}});
  void nativeControl; // Fixture-owned instance; never returned or messaged.
  ok(sentinel[0]===2026,'native control executes untranslated start');sentinel[0]=0;
  const guarded=group.create(1,65536);
  for(const input of [untranslated,untranslatedStartup]) {
    let rejected=false;try{await M.vmInstantiate(input,{env:{memory:guarded}});}catch{rejected=true;}
    ok(rejected,'async untranslated instantiation refused');ok(sentinel[0]===0,'async rejection precedes native startup');
  }
  throws(()=>M.vmConstruct(WebAssembly.Instance,untranslated,{env:{memory:guarded}}),'sync untranslated instantiation refused');
  ok(sentinel[0]===0,'sync rejection precedes native startup');retire(guarded);
  cases.push('unsupported module rejected before startup side effects');
  const first=group.create(2,64),oldRoot=first.root;
  first.write(0,Uint8Array.of(91));
  const oldView=M.vmConstruct(Uint8Array,first.buffer),oldData=M.vmConstruct(DataView,first.buffer);
  let wire;M.vmPostMessage({postMessage:value=>{wire=value;}},{type:'centralized_init',memory:first});
  retire(first);
  throws(()=>first.read(0,1),'retired handle refuses reads');
  throws(()=>{oldView[0]=88;},'retired typed alias refuses writes');
  throws(()=>oldData.getUint8(0),'retired DataView refuses reads');
  const successor=group.create(2,64);
  ok(successor.root===oldRoot,'actual physical root is reused');
  ok(successor.read(0,2*PAGE).every(x=>x===0),'recycled private payload zeroed');
  throws(()=>M.vmDecodeMessage(wire),'delayed old wire refuses successor binding');
  ok(successor.read(0,1)[0]===0,'stale alias cannot corrupt successor');
  retire(successor); cases.push('root reuse, zeroing and stale handle/view/wire rejection');

  const parent=group.create(2,64);
  parent.write(0,Uint8Array.of(31));parent.write(PAGE,Uint8Array.of(41));
  M.vmTrackAnonymous(parent,PAGE,PAGE,3);
  const snapshot=M.vmForkSnapshot(parent.buffer,parent.buffer.byteLength);
  retire(parent);
  ok(group.reuseStats().pendingSnapshots===1,'snapshot remains pinned after source retirement');
  const child=group.create(2,64,true);
  ok(M.vmCopyFork(child.buffer,snapshot),'fork snapshot copied after source retirement');
  ok(child.read(0,1)[0]===31&&child.read(PAGE,1)[0]===41,'private copy and live shared payload survive retirement');
  ok(group.reuseStats().pendingSnapshots===0,'successful copy releases snapshot ownership');
  retire(child); cases.push('asynchronous fork survives retiring source generation');

  const cancelled=group.create(2,64);M.vmTrackAnonymous(cancelled,PAGE,PAGE,3);
  const abandoned=M.vmForkSnapshot(cancelled.buffer,cancelled.buffer.byteLength);
  retire(cancelled);ok(group.reuseStats().pendingSnapshots===1,'abandoned snapshot retains pin');
  M.disposeProcessForkSnapshot(abandoned);M.disposeProcessForkSnapshot(abandoned);
  ok(group.reuseStats().pendingSnapshots===0&&group.reuseStats().deferredPages===0,'explicit cancellation releases last pin once');
  cases.push('explicit snapshot cancellation after source retirement');

  const before=high();
  for(let i=0;i<256;i++) {
    const memory=group.create(2,64);memory.write(0,Uint8Array.of(i&255));retire(memory);
  }
  ok(high()===before,'256 real virtual root/scratch/payload generations have flat high-water');
  ok(group.reuseStats().rootsTracked===0,'retired roots are removed');
  const unpublished=group.create(2,64);M.rejectUnpublishedProcessBacking(unpublished);
  throws(()=>unpublished.read(0,1),'rejected unpublished root revoked');
  ok(group.reuseStats().rootsTracked===0,'rejected unpublished allocation returns all ownership');
  const escaped=group.create(2,64);M.vmPostMessage({postMessage:()=>{}},{type:'centralized_init',memory:escaped});
  M.rejectUnpublishedProcessBacking(escaped);
  ok(group.reuseStats().quarantinedRoots===1,'rejected exposed factory result quarantined');
  cases.push('unpublished allocation rollback and exposed-factory quarantine');
  const forced=group.create(2,64);retire(forced,'forced');
  ok(group.reuseStats().quarantinedRoots===2,'missing quiescence quarantines root');
  throws(()=>forced.read(0,1),'quarantined owner handle refuses access');
  cases.push('bounded generation churn and forced quarantine');
  return {passed:true,checks,cases,highWaterPages:high(),ownership:group.reuseStats(),scope:'Virtual-memory component ownership; actual process-worker quiescence is tested separately.'};
}
