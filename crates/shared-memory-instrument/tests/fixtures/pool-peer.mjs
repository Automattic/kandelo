import {MemoryGroupPagePool} from '../../../../host/src/memory-group-pool.ts';
export async function runPeer({bytes,memory,root,scratch,replica,barrier,cycles,identity,maximumPages},ready) {
  const pool=MemoryGroupPagePool.attach(memory,maximumPages),P=65536;
  const words=new Uint32Array(memory.buffer),pte=root/4+16,flags=new Int32Array(barrier);
  const e=(await WebAssembly.instantiate(bytes,{'kandelo.memory-group.v3':{memory}})).instance.exports;
  e.__vm_root.value=root;e.__vm_scratch.value=scratch;e.__vm_replica.value=replica;e.__vm_initialize(1);ready();
  Atomics.wait(flags,0,0,10000);if(Atomics.load(flags,0)!==1)throw Error('Peer start deadline');
  for(let cycle=0;cycle<cycles;cycle++) {
    if(e.grow(4)!==2)throw Error('Peer grow refused');
    const pages=Array.from({length:4},(_,i)=>(words[pte+2+i]>>>16));
    if(new Set(pages).size!==4)throw Error('Duplicate allocation inside peer');
    const value=identity*100000+cycle;
    for(let i=0;i<4;i++) {
      if(e.read32((2+i)*P)!==0)throw Error('Reused page not zero');
      e.write32((2+i)*P,value);
    }
    Atomics.wait(flags,1,0,0.25); // Give other real Workers an overlap window.
    for(let i=0;i<4;i++)if(e.read32((2+i)*P)!==value)throw Error('Live page overwritten by another allocator');
    for(let i=0;i<4;i++)words[pte+2+i]=0;
    Atomics.store(words,root/4,2);
    // No outstanding C call or other user of this peer's released range.
    pool.releaseRetiredPages(pages);
  }
  return {passed:true,cycles,identity};
}
