// Run in a disposable Worker. Only copied check names leave its realm.
export async function checkDataInit(ordinaryBytes,groupedBytes,activeOrdinaryBytes,activeGroupedBytes) {
  const P=65536,root=P,scratch=2*P,replica=3*P,dataLength=2*P+31;
  const plainMemory=new WebAssembly.Memory({initial:3,maximum:32,shared:true});
  const ordinary=(await WebAssembly.instantiate(ordinaryBytes,{env:{memory:plainMemory}})).instance.exports;
  const memory=new WebAssembly.Memory({initial:64,maximum:128,shared:true});
  const grouped=(await WebAssembly.instantiate(groupedBytes,{'kandelo.memory-group.v3':{memory}})).instance.exports;
  const words=new Uint32Array(memory.buffer),payload=new Uint8Array(memory.buffer),plain=new Uint8Array(plainMemory.buffer),checks=[];
  words[root/4]=3;words[root/4+1]=32;words[root/4+2]=P;words[root/4+14]=1;
  words[replica/4]=1;words[(replica+12)/4]=root;words[(replica+60)/4]=861031755;
  grouped.__vm_root.value=root;grouped.__vm_scratch.value=scratch;grouped.__vm_replica.value=replica;
  const mapping=[4,6,7];mapping.forEach((p,i)=>words[root/4+16+i]=p*P|3);grouped.__vm_initialize(1);
  const physical=v=>mapping[v>>>16]*P+(v&(P-1));
  function reset(){payload.fill(0x7d,4*P,8*P);plain.fill(0x7d);}
  function trap(fn){try{fn();return false;}catch(error){if(!(error instanceof WebAssembly.RuntimeError))throw error;return true;}}
  function check(name,value){if(!value)throw Error(name);checks.push(name);}
  function copy(name,dst,src,n){
    reset();const expected=payload.slice(4*P,8*P);
    for(let i=0;i<n;i++)expected[physical(dst+i)-4*P]=(src+i)%251;
    ordinary.init(dst,src,n);grouped.init(dst,src,n);
    check(name,payload.subarray(4*P,8*P).every((v,i)=>v===expected[i])&&plain.subarray(dst,dst+n).every((v,i)=>v===(src+i)%251));
  }
  copy('large fragmented passive initialization',5,7,2*P+23);
  mapping[2]=4;words[root/4+18]=4*P|3;
  copy('passive initialization preserves repeated destination writes',5,7,2*P+23);
  mapping[2]=7;words[root/4+18]=7*P|3;
  for(const [name,dst,src,n] of [
    ['source end preflight',5,32,2*P],['source addition overflow',5,0xffffffff,2],
    ['zero length past source end',0,dataLength+1,0],['destination end preflight',3*P-1,0,2],
  ]){
    reset();const before=payload.slice(4*P,8*P);
    check(name,trap(()=>ordinary.init(dst,src,n))&&trap(()=>grouped.init(dst,src,n))&&payload.subarray(4*P,8*P).every((v,i)=>v===before[i]));
  }
  reset();words[root/4+18]&=~2;const before=payload.slice(4*P,8*P);
  check('initialization permission preflight',trap(()=>grouped.init(5,7,2*P+23))&&payload.subarray(4*P,8*P).every((v,i)=>v===before[i]));words[root/4+18]|=2;
  ordinary.init(3*P,dataLength,0);grouped.init(3*P,dataLength,0);check('zero length at both bounds',true);
  ordinary.drop();grouped.drop();ordinary.init(3*P,0,0);grouped.init(3*P,0,0);check('dropped segment zero-length origin',true);
  for(const [name,src,n] of [['dropped segment payload',0,1],['dropped segment zero-length past origin',1,0]]){
    reset();const before=payload.slice(4*P,8*P);
    check(name,trap(()=>ordinary.init(0,src,n))&&trap(()=>grouped.init(0,src,n))&&payload.subarray(4*P,8*P).every((v,i)=>v===before[i]));
  }
  let ordinaryStartTrapped=false;
  try{await WebAssembly.instantiate(activeOrdinaryBytes,{env:{memory:plainMemory}});}catch(error){if(!(error instanceof WebAssembly.RuntimeError))throw error;ordinaryStartTrapped=true;}
  const active=(await WebAssembly.instantiate(activeGroupedBytes,{'kandelo.memory-group.v3':{memory}})).instance.exports;
  words[root/4+3]=0;active.__vm_root.value=root;active.__vm_scratch.value=scratch;active.__vm_replica.value=replica;
  check('active data is dropped before original start',ordinaryStartTrapped&&trap(()=>active.__vm_initialize(1)));
  return {checks,scope:'Native Wasm memory.init versus translated output, independent data pattern and physical snapshot oracle. No normal grouped lifecycle or performance claim.'};
}
