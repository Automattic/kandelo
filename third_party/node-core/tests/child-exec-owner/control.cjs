'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),util=require('node:util'),events=require('node:events');
const mode=process.argv[2],repo=path.resolve(process.argv[3]);assert.equal(process.version,'v26.13.0');
const api=require('./load.cjs')(mode,repo);const rows=[];
function bytes(x){return Buffer.isBuffer(x)?{type:'Buffer',hex:x.toString('hex')}:{type:typeof x,value:x};}
function error(e){if(!e)return null;return{name:e.name,code:e.code,message:e.message,killed:e.killed,signal:e.signal,cmd:e.cmd};}
async function group(name,body){try{rows.push({name,result:await body()});}catch(e){rows.push({name,nonpass:{name:e.name,code:e.code,message:e.message}});}}
function run(script,options={},args=[]){return new Promise((resolve,reject)=>{
 let child,called=0,guard;const safety=setTimeout(()=>{guard=true;child?.kill('SIGKILL');},1500);
 try{child=api.execFile(process.execPath,['-e',script,...args],options,(e,out,err)=>{called++;clearTimeout(safety);resolve({error:error(e),stdout:bytes(out),stderr:bytes(err),called,...guard?{fixtureSafetyKill:true}:{}});});}catch(e){clearTimeout(safety);reject(e);}
 });}
function invalid(args){try{const c=api.execFile(...args);c.removeAllListeners('close');c.removeAllListeners('error');c.on('error',()=>{});c.stdin?.on('error',()=>{});c.stdin?.end();return'no synchronous error';}catch(e){return{name:e.name,code:e.code,message:e.message};}}
(async()=>{
 await group('default encoding split UTF8 and stderr',()=>run("process.stdout.write(Buffer.from([0xe2]));setTimeout(()=>{process.stdout.write(Buffer.from([0x82,0xac]));process.stderr.write('error');},20)"));
 for(const encoding of [null,'buffer','invalid',undefined])await group('buffer encoding '+String(encoding),()=>run("process.stdout.write(Buffer.from([0,255,97]));process.stderr.write(Buffer.from([254]));",{encoding}));
 await group('stdout maxBuffer byte boundary',()=>run("process.stdout.write('abcdefgh');",{maxBuffer:3}));
 await group('stderr maxBuffer byte boundary',()=>run("process.stderr.write('abcdefgh');",{maxBuffer:3}));
 await group('zero maxBuffer',()=>run("process.stdout.write('x');",{maxBuffer:0}));
 await group('infinite maxBuffer',async()=>{const v=await run("process.stdout.write(Buffer.alloc(1100000,97));",{maxBuffer:Infinity});return{error:v.error,type:v.stdout.type,length:v.stdout.value?.length,stderr:v.stderr,called:v.called};});
 await group('timeout real child termination',()=>run("setInterval(()=>{},1000)",{timeout:60,killSignal:'SIGKILL'}));
 await group('nonzero exit command and outputs',()=>run("process.stdout.write('out');process.stderr.write('err');process.exitCode=7",{},['one','two']));
 await group('options object overload',()=>new Promise(resolve=>{const inputErrors=[];const c=api.execFile(process.execPath,{encoding:'buffer'},(e,out,err)=>resolve({error:error(e),out:bytes(out),err:bytes(err),inputErrors}));c.stdin.on('error',e=>inputErrors.push(e.code));c.stdin.end('process.stdout.write("options")');}));
 await group('stdin remains caller-owned',async()=>{let finish;const result=new Promise(resolve=>finish=resolve);const c=api.execFile(process.execPath,['-e',"process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('end'))"],(e,out,err)=>finish({error:error(e),out:bytes(out),err:bytes(err)}));const ended=c.stdin.writableEnded;c.stdin.end();return{ended,result:await result};});
 await group('custom promisify descriptors',()=>{const result={};for(const n of ['exec','execFile']){const d=Object.getOwnPropertyDescriptor(api[n],util.promisify.custom);result[n]=d?{name:d.value.name,length:d.value.length,enumerable:d.enumerable,writable:d.writable,configurable:d.configurable}:null;}return result;});
 await group('custom promise child and result',async()=>{const p=util.promisify(api.execFile)(process.execPath,['-p','42']);const child=p.child;const result=await p;return{actualChild:child instanceof require('node:child_process').ChildProcess,result};});
 await group('custom promise rejection output identity',async()=>{const p=util.promisify(api.execFile)(process.execPath,['-e',"process.stdout.write('out');process.stderr.write('err');process.exitCode=2"]);try{await p;return'unexpected fulfillment';}catch(e){return{code:e.code,stdout:bytes(e.stdout),stderr:bytes(e.stderr),actualChild:p.child instanceof require('node:child_process').ChildProcess};}});
 await group('exec live public execFile dispatch',()=>{const old=api.execFile;let actual;const sentinel={};const cb=()=>{};try{api.execFile=(...args)=>(actual=args,sentinel);const returned=api.exec('printf x',{shell:'/bin/sh'},cb);return{returned:returned===sentinel,args:[actual?.[0],actual?.[1]?.shell,actual?.[2]===cb]};}finally{api.execFile=old;}});
 await group('validation timeout',()=>invalid([process.execPath,[],{timeout:-1}]));
 await group('validation maxBuffer',()=>invalid([process.execPath,[],{maxBuffer:'1'}]));
 await group('validation killSignal',()=>invalid([process.execPath,[],{killSignal:'BOGUS'}]));
 await group('validation callback',()=>invalid([process.execPath,[],{},42]));
 await group('validation argv0 null byte',()=>invalid([process.execPath,[],{argv0:'bad\0arg'}]));
 await group('missing executable original error',()=>new Promise(resolve=>{api.execFile('/__kandelo_collector_missing_executable__',['argument'],(e,out,err)=>resolve({name:e.name,code:e.code,syscall:e.syscall,path:e.path,spawnargs:e.spawnargs,out:bytes(out),err:bytes(err)}));}));
 console.log(JSON.stringify({mode,rows,scope:'Actual production collector over explicit native spawn/Buffer/stream/timer/error dependencies, not guest spawn/abort/signals/four-host proof'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
