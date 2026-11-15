import {shortScalarChecks} from './short-scalar-checks.mjs';
self.onmessage=async({data:{mode}})=>{
 try{if(!['baseline','dataview','typed'].includes(mode))throw Error('unknown mode');
 const api=await import('/artifacts/'+mode+'-memory.mjs');self.postMessage({mode,result:shortScalarChecks(api)});
 }catch(e){self.postMessage({mode,error:String(e.stack||e)});}
};
