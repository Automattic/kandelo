import {runProbe} from './probe.mjs';
try {
  const response=await fetch(new URL('probe.wasm',import.meta.url));
  if(!response.ok)throw Error(`HTTP ${response.status}`);
  postMessage(runProbe(await response.arrayBuffer()));
}catch(error){postMessage({passed:false,failureKind:'mechanism-error',error:String(error.stack||error)});}
close();
