import {runByteSliceChecks} from './byte-slice-checks.mjs';
self.onmessage=async()=>{
 try {
  const baseline=await import('/artifacts/baseline-memory.mjs'),candidate=await import('/artifacts/candidate-memory.mjs');
  self.postMessage({result:runByteSliceChecks(baseline,candidate)});
 }catch(error){self.postMessage({error:String(error)+'\n'+String(error.stack||'')});}
};
