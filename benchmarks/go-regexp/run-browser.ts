import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import config from '../../apps/browser-demos/playwright.config.ts';
const require = createRequire(resolve('apps/browser-demos/package.json'));
const browsers = require('@playwright/test');
const outputDir = resolve(process.argv[2] ?? '.context/go-regexp-evaluation');
const variants = ['baseline', 'candidate'];
const cases = (process.env.REGEXP_BENCH_CASES ?? 'literal,literal-text,class,capture,bounded-lazy,url').split(',');
const files = new Map(variants.map(variant => ['/' + variant + '.wasm', readFileSync(resolve(outputDir, 'bench-' + variant + '-wasi.wasm'))]));
const rounds = Number(process.env.REGEXP_BENCH_ROUNDS ?? 3);
if (!Number.isInteger(rounds) || rounds < 1) throw Error('REGEXP_BENCH_ROUNDS must be a positive integer');
const server = createServer((req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    const bytes = files.get(req.url ?? '');
    res.setHeader('Content-Type', bytes ? 'application/wasm' : 'text/html');
    res.end(bytes ?? '<title>Regexp compilation benchmark</title>');
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string')
    throw Error('missing test address');
const base = 'http://127.0.0.1:' + address.port;
const workerCode = String.raw `self.onmessage=async({data:{url,name}})=>{
 let instance,stdout='',stderr='',exitCode=null,error=null;const unsupported=[];const fdFlags=new Map([[0,0],[1,0],[2,0]]);const environment=new TextEncoder().encode("REGEXP_BENCH_CASE="+name+"\0GOMAXPROCS=1\0");
 const view=()=>new DataView(instance.exports.memory.buffer);
 const bytes=()=>new Uint8Array(instance.exports.memory.buffer);
 const imports={
  args_sizes_get:(count,size)=>{view().setUint32(count,0,true);view().setUint32(size,0,true);return 0;},args_get:()=>0,
  environ_sizes_get:(count,size)=>{view().setUint32(count,2,true);view().setUint32(size,environment.length,true);return 0;},environ_get:(pointers,target)=>{bytes().set(environment,target);view().setUint32(pointers,target,true);view().setUint32(pointers+4,target+environment.indexOf(0)+1,true);return 0;},
  clock_time_get:(id,precision,target)=>{view().setBigUint64(target,id===0?BigInt(Date.now())*1000000n:BigInt(Math.floor(performance.now()*1000000)),true);return 0;},
  random_get:(target,size)=>{crypto.getRandomValues(bytes().subarray(target,target+size));return 0;},
  fd_fdstat_get:(fd,target)=>{if(fd<0||fd>2)return 8;bytes().fill(0,target,target+24);view().setUint8(target,2);view().setUint16(target+2,fdFlags.get(fd),true);return 0;},
  fd_fdstat_set_flags:(fd,flags)=>{if(!fdFlags.has(fd))return 8;if(flags&~31)return 28;fdFlags.set(fd,flags);return 0;},
  fd_prestat_get:()=>8,
  fd_write:(fd,iovs,count,written)=>{if(fd!==1&&fd!==2)return 8;let text='',total=0;for(let i=0;i<count;i++){const p=view().getUint32(iovs+i*8,true),n=view().getUint32(iovs+i*8+4,true);text+=new TextDecoder().decode(bytes().subarray(p,p+n));total+=n;}if(fd===1)stdout+=text;else stderr+=text;view().setUint32(written,total,true);return 0;},
  // Preview-1 clock subscriptions: runtime/os_wasip1.go defines the
  // 48-byte subscription and 32-byte event layouts. Never wake early.
  poll_oneoff:(input,output,count,events)=>{
   if(count===0)return 28;
   const now=id=>id===0?BigInt(Date.now())*1000000n:BigInt(Math.floor(performance.now()*1000000));
   const clocks=[];
   for(let i=0;i<count;i++){
    const p=input+i*48,type=view().getUint8(p+8);
    if(type!==0)throw Error('unimplemented benchmark FD poll subscription '+type);
    const id=view().getUint32(p+16,true),timeout=view().getBigUint64(p+24,true),flags=view().getUint16(p+40,true);
    if(id>1||flags&~1)throw Error('unsupported benchmark clock subscription');
    clocks.push({userdata:view().getBigUint64(p,true),id,deadline:flags&1?timeout:now(id)+timeout});
   }
   const sleeper=new Int32Array(new SharedArrayBuffer(4));
   for(;;){
    const ready=clocks.filter(clock=>clock.deadline<=now(clock.id));
    if(ready.length){
     for(let i=0;i<ready.length;i++){const p=output+i*32;bytes().fill(0,p,p+32);view().setBigUint64(p,ready[i].userdata,true);}
     view().setUint32(events,ready.length,true);return 0;
    }
    const remaining=clocks.reduce((min,clock)=>{const n=clock.deadline-now(clock.id);return min===null||n<min?n:min;},null);
    if(remaining>0n)Atomics.wait(sleeper,0,0,Number(remaining)/1000000);
   }
  },
  proc_exit:code=>{throw {wasiExit:code};},sched_yield:()=>0,
 };
 try{
  const response=await fetch(url);if(!response.ok)throw Error('fetch '+response.status);
  const module=await WebAssembly.compile(await response.arrayBuffer());
  for(const item of WebAssembly.Module.imports(module)){
   if(item.module!=='wasi_snapshot_preview1')throw Error('unexpected import namespace '+item.module);
   if(!(item.name in imports))imports[item.name]=()=>{unsupported.push(item.name);throw Error('unimplemented control import '+item.name);};
  }
  instance=await WebAssembly.instantiate(module,{wasi_snapshot_preview1:imports});
  instance.exports._start();exitCode=0;
 }catch(failure){if(failure&&'wasiExit' in Object(failure))exitCode=failure.wasiExit;else error={name:failure?.name,message:String(failure),stack:String(failure?.stack??'').slice(0,6000)};}
 self.postMessage({exitCode,stdout,stderr,error,unsupported,linearBytes:instance?.exports.memory.buffer.byteLength});
};`;
const rows: any[] = [];
try {
    for (const engine of ['chromium', 'firefox', 'webkit']) {
        const project = config.projects!.find(project => project.name === engine)!;
        const use: any = project.use;
        for (let round = 0; round < rounds; round++) {
            const browser = await browsers[engine].launch({ ...config.use?.launchOptions, ...use.launchOptions, ...(use.channel ? { channel: use.channel } : {}) });
            try {
                for (const name of cases) {
                    for (const variant of (round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])) {
                        const page = await browser.newPage();
                        try {
                            await page.goto(base);
                            const result: any = await page.evaluate(async ({ workerCode, url, name }) => new Promise((resolve, reject) => {
                                const blob = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
                                const worker = new Worker(blob);
                                const timer = setTimeout(() => { worker.terminate(); URL.revokeObjectURL(blob); reject(Error('benchmark timeout')); }, 30000);
                                worker.onmessage = event => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(blob); resolve(event.data); };
                                worker.onerror = event => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(blob); reject(Error(event.message)); };
                                worker.postMessage({ url, name });
                            }), { workerCode, url: base + '/' + variant + '.wasm', name });
                            const parsed = result.exitCode === 0 && !result.error ? JSON.parse(result.stdout) : null;
                            rows.push({ engine, browserVersion: browser.version(), round, name, variant, result, parsed, sha256: createHash('sha256').update(files.get('/' + variant + '.wasm')!).digest('hex') });
                            console.log(JSON.stringify({ engine, round, name, variant, error: result.error?.message, nsPerOp: parsed?.Samples.map(sample => sample.DurationNs / parsed.N) }));
                            writeFileSync(resolve(outputDir, 'browser-benchmarks.json'), JSON.stringify({ scope: 'Fresh worker/page per row; fresh browser per round; alternating variants; compilation only; WASI32; GOMAXPROCS=1; retain baseline WebKit overflow', rows }, null, 2) + '\n');
                        }
                        finally {
                            await page.close();
                        }
                    }
                }
            }
            finally {
                await browser.close();
            }
        }
    }
    const expected = 3 * rounds * cases.length * variants.length;
    if (rows.length !== expected)
        throw Error('Incomplete browser inventory: ' + rows.length + '/' + expected);
    for (const row of rows) {
        if (row.result.unsupported.length)
            throw Error('Unsupported WASI imports: ' + JSON.stringify(row));
        if (row.result.exitCode === 0 && !row.result.error && row.parsed)
            continue;
        if (row.engine === 'webkit' && row.name === 'url' && row.variant === 'baseline' && /call stack/i.test(row.result.error?.message ?? ''))
            continue;
        throw Error('Unexpected benchmark failure: ' + JSON.stringify(row));
    }
}
finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
