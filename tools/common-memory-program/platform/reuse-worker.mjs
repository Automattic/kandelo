import {runReuseChecks} from './reuse-checks.mjs';
self.onmessage=async({data})=>{try{const M=await import('/artifacts/'+data.mode+'-memory.mjs');const module=await WebAssembly.compile(await(await fetch('/php-fpm-vm.wasm')).arrayBuffer());self.postMessage(await runReuseChecks(M,module));}catch(error){self.postMessage({passed:false,error:String(error),stack:error?.stack});}};
