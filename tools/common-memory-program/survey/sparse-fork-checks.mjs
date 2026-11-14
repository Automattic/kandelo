// Sparse destination allocation checks; no retirement/reuse claim.
export function sparseForkChecks(m) {
 let checks=0;const ok=(v,s)=>{if(!v)throw Error(s);checks++;},used=g=>new Uint32Array(g.memory.buffer,4096,3)[1]*65536;
 const g=new m.VirtualGroup(undefined,{maximumPages:1024,scratchBytes:65536}),parent=g.create(8,16),bytes=m.vmConstruct(Uint8Array,parent.buffer);
 bytes[11]=42;bytes[4*65536+3]=19;
 // One inherited shared page, one private alias, two holes.
 parent.table()[1]|=4;parent.table()[5]=parent.table()[4];parent.table()[6]=0;parent.table()[7]=0;
 const before=used(g),child=g.create(8,16,true);ok([...child.table().subarray(0,8)].every(e=>e===0),'fork destination has no preallocated payload');
 const afterMetadata=used(g);ok(afterMetadata-before===2*65536,'only root and scratch allocated before copy');
 m.vmCopyFork(child.buffer,parent.buffer);const copied=used(g)-afterMetadata;ok(copied===4*65536,'only four unique private payload pages allocated');
 const c=m.vmConstruct(Uint8Array,child.buffer);ok(c[11]===42,'private bytes copied');c[11]=77;ok(bytes[11]===42,'private writes isolated');
 c[65536+1]=98;ok(bytes[65536+1]===98,'inherited shared backing remains live');
 c[5*65536+3]=81;ok(c[4*65536+3]===81&&bytes[4*65536+3]===19,'private aliases copied once and preserved');
 ok(child.table()[6]===0&&child.table()[7]===0,'holes remain holes');let trapped=false;try{void c[6*65536];}catch{trapped=true;}ok(trapped,'unmapped child access fails');
 const captured=m.vmForkSnapshot(parent.buffer,parent.buffer.byteLength);m.vmCopyFork(captured,parent.buffer);bytes[11]=91;bytes[65536+1]=33;
 const asyncChild=g.create(8,16,true);m.vmCopyFork(asyncChild.buffer,captured);const a=m.vmConstruct(Uint8Array,asyncChild.buffer);
 ok(a[11]===42,'async captured private data predates mutation');ok(a[65536+1]===33,'async captured shared page stays live');
 return{passed:true,checks,copyPayloadBytes:copied,scope:'Sparse fork destination allocation, private alias/isolation, shared data and synchronous/asynchronous snapshot semantics. No extent reuse.'};
}
