// Synthetic feature/alias mechanism, no Kandelo kernel or production admission.
// Only a disposable Worker executes this function; plain diagnostic data leaves.
export function runProbe(bytes) {
  const result={scope:'ARCH-01 synthetic multi-memory mechanism, not real fork/PHP or performance',supported:WebAssembly.validate(bytes),checks:[],passed:false};
  if(!result.supported)return {...result,failureKind:'unsupported-default-engine-multi-memory'};
  const module=new WebAssembly.Module(bytes);
  const privateA=new WebAssembly.Memory({initial:2,maximum:4,shared:true});
  const privateB=new WebAssembly.Memory({initial:2,maximum:4,shared:true});
  const shared=new WebAssembly.Memory({initial:2,maximum:4,shared:true});
  const instance=(privateMemory,sharedMemory)=>new WebAssembly.Instance(module,{env:{private:privateMemory,shared:sharedMemory}});
  const a=instance(privateA,shared),b=instance(privateB,shared),base=0x80000000,page=65536;
  const equal=(got,want,message)=>{if(got!==want)throw Error(`${message}: ${got} != ${want}`);};
  const trap=fn=>{try{fn();}catch(e){if(e instanceof WebAssembly.RuntimeError)return;throw e;}throw Error('missing bounds trap');};
  a.exports.private_store(0,base+256);a.exports.private_store(4,64);a.exports.private_store(64,17);
  a.exports.store(base+256,101);
  // Synthetic private-byte copy: explicitly not the Kandelo fork mechanism.
  new Uint8Array(privateB.buffer).set(new Uint8Array(privateA.buffer));
  equal(b.exports.load(b.exports.private_load(0)),101,'inherited shared pointer');
  equal(b.exports.load(b.exports.private_load(4)),17,'inherited private pointer');
  b.exports.store(b.exports.private_load(4),99);equal(a.exports.load(64),17,'parent private isolation');
  b.exports.store(b.exports.private_load(0),202);equal(a.exports.load(base+256),202,'live shared pointer');
  result.checks.push('canonical private/shared pointers survive synthetic private copy','private isolation and live shared payload');
  a.exports.store(base+1024,7);equal(b.exports.shared_add(1024,5),7,'cross-instance atomic old value');
  equal(a.exports.load(base+1024),12,'cross-instance atomic live value');
  result.checks.push('atomics address the same shared storage');
  trap(()=>a.exports.load(2*page));trap(()=>b.exports.load(base+2*page));
  equal(a.exports.grow_private(1),2,'private grow old size');
  equal(a.exports.private_pages(),3,'parent private size');equal(b.exports.private_pages(),2,'child private size');
  a.exports.store(2*page,303);equal(a.exports.load(2*page),303,'grown private value');trap(()=>b.exports.load(2*page));
  equal(a.exports.grow_shared(1),2,'shared grow old size');equal(b.exports.shared_pages(),3,'shared growth visible');
  a.exports.store(base+2*page,404);equal(b.exports.load(base+2*page),404,'grown shared payload');
  equal(a.exports.grow_shared(2),-1,'shared maximum enforced');equal(a.exports.shared_pages(),3,'failed grow unchanged');
  result.checks.push('native bounds and independent private/shared growth','declared maximum enforced');
  // Import indices alone do not prove distinct backing objects. This legal
  // alias control must remain correct after any future hoisting experiment.
  const alias=instance(shared,shared);
  alias.exports.private_store(512,505);equal(alias.exports.load(base+512),505,'aliased imports');
  result.importAliasAccepted=true;result.checks.push('same object can back both memory imports');
  result.maximumReservationBytes=3*4*page;
  result.initialBufferBytes=3*2*page;result.finalBufferBytes=privateA.buffer.byteLength+privateB.buffer.byteLength+shared.buffer.byteLength;
  result.integrationPending=['normal SDK C code generation','Kandelo fork/ABI and worker binding','generic mmap/mprotect/remap semantics','shared allocation policy','PHP/WordPress correctness and performance'];
  result.passed=true;return result;
}
