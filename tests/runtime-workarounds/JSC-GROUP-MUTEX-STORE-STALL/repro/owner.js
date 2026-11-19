onmessage=async({data})=>{
 const workers=[];const rows=[];
 try{
  const memory=new WebAssembly.Memory({initial:8192,maximum:8192,shared:true});
  const module=await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,1,127,0,2,18,1,3,101,110,118,6,109,101,109,111,114,121,2,3,1,128,128,4,3,4,3,0,0,0,7,32,3,8,101,120,99,104,97,110,103,101,0,0,9,114,101,97,100,102,105,114,115,116,0,1,5,115,116,111,114,101,0,2,10,80,3,29,0,2,64,3,64,32,0,65,1,254,65,2,0,69,13,1,12,0,11,11,32,0,65,0,254,23,2,0,11,37,0,2,64,3,64,32,0,254,16,2,0,13,0,32,0,65,1,254,65,2,0,69,13,1,12,0,11,11,32,0,65,0,254,23,2,0,11,10,0,32,0,65,0,254,23,2,0,11]));
  const instance=new WebAssembly.Instance(module,{env:{memory}}),words=new Int32Array(memory.buffer);
  let readyResolve,enterResolve,doneResolve;let readyCount=0,enterCount=0,doneCount=0;
  const ready=new Promise(resolve=>{readyResolve=resolve;});
  for(let i=0;i<8;i++){const worker=new Worker('/contender.js');workers.push(worker);worker.onmessage=({data:m})=>{if(m.type==='ready'&&++readyCount===8)readyResolve();if(m.type==='entering'&&++enterCount===8)enterResolve();if(m.type==='done'&&++doneCount===8)doneResolve();};worker.onerror=e=>postMessage({error:e.message});worker.postMessage({type:'init',module,memory,algorithm:data.algorithm});}
  await ready;
  function releaseJS(){const before=performance.now();Atomics.store(words,0,0);const stored=performance.now();return stored-before;}
  function releaseWasm(){const before=performance.now();instance.exports.store(0);const stored=performance.now();return stored-before;}
  const release=data.release==='js'?releaseJS:releaseWasm;
  for(let i=0;i<20000;i++){Atomics.store(words,0,1);release();}
  for(let round=0;round<32;round++){
   enterCount=doneCount=0;const entering=new Promise(resolve=>{enterResolve=resolve;}),done=new Promise(resolve=>{doneResolve=resolve;});
   if(Atomics.compareExchange(words,0,0,1)!==0)throw Error('Owner mutex not free');
   for(const worker of workers)worker.postMessage({type:'run'});
   await entering;await new Promise(resolve=>setTimeout(resolve,100));
   const storeMs=release();await done;if(Atomics.load(words,0)!==0)throw Error('Contender did not release');
   rows.push({round,storeMs});postMessage({row:rows.at(-1)});
  }
  const maxStoreMs=Math.max(...rows.map(r=>r.storeMs));postMessage({done:true,rows,maxStoreMs,reproduced:maxStoreMs>250,scope:'Standalone memory/lock at byte0, no application code or application layout'});
 }catch(error){postMessage({error:String(error)});}finally{for(const worker of workers)worker.terminate();}
};
