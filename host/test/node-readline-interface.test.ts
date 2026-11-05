import { createRequire } from 'node:module';
import { PassThrough, Writable } from 'node:stream';
import { once } from 'node:events';
import * as readline from 'node:readline';
import * as promises from 'node:readline/promises';
import { describe, expect, it } from 'vitest';
const fixture=createRequire(import.meta.url)('./fixtures/node-readline-interface.cjs');
const target=createRequire(import.meta.url)('../../packages/registry/node-compat/target.json');
function failure(fn:()=>unknown){try{fn();}catch(e:any){return{name:e.name,code:e.code,message:e.message};}}
describe.skipIf(process.versions.node!==target.version)('pinned readline interface owners',()=>{
  it('owns callback/promise constructor identity and shared cursor namespace',()=>{
    const subject=fixture.create();expect(subject.api.promises).toBe(subject.promises);
    expect(subject.api.cursorTo).toBe(subject.callbacks.cursorTo);
    for(const api of [subject.api,readline]) {
      const input=new PassThrough(),rl=api.createInterface({input,terminal:false});
      try {expect(rl instanceof api.Interface).toBe(true);expect(api.Interface.length).toBe(readline.Interface.length);}
      finally{rl.close();input.destroy();}
    }
    // The factory returns the CJS builtin; ESM namespace default/interop
    // properties belong to the separate loader control.
    for(const key of Object.keys(createRequire(import.meta.url)('node:readline')))
      expect(key in subject.api,key).toBe(true);
  });
  it('delivers actual split UTF-8/CRLF/Unicode lines and closes once on EOF',async()=>{
    async function run(api:any){
      const input=new PassThrough(),rl=api.createInterface({input,terminal:false,crlfDelay:Infinity});
      const lines:string[]=[],events:string[]=[];rl.on('line',(line:string)=>lines.push(line));rl.on('close',()=>events.push('close'));
      const closed=once(rl,'close');
      try {
        for(const part of [Buffer.from([0xe2]),Buffer.from([0x98]),Buffer.from([0x83]),Buffer.from('one\r'),Buffer.from('\ntwo\u2028three\u2029last')])input.write(part);
        input.end();await closed;rl.close();
        return {lines,events,closed:rl.closed,dataListeners:input.listenerCount('data'),endListeners:input.listenerCount('end')};
      } finally{rl.close();input.destroy();}
    }
    expect(await run(fixture.create().api)).toEqual(await run(readline));
  });
  it('waits for a callback answer from configured input and writes the real prompt',async()=>{
    async function run(api:any){
      const input=new PassThrough(),writes:string[]=[],output=new Writable({write(c,_e,cb){writes.push(`${c}`);cb();}});
      const rl=api.createInterface({input,output,terminal:false,prompt:'base>'});let answered=false;
      try {
        const answer=new Promise<string>(resolve=>rl.question('question?',(value:string)=>{answered=true;resolve(value);}));
        const before=[answered,writes.slice(),rl.getPrompt()];input.write('actual answer\n');
        return {before,answer:await answer,afterPrompt:rl.getPrompt(),writes};
      }finally{rl.close();input.destroy();output.destroy();}
    }
    expect(await run(fixture.create().api)).toEqual(await run(readline));
  });
  it('owns promise answers and abort cancellation without consuming the next question',async()=>{
    async function run(api:any){
      const input=new PassThrough(),output=new PassThrough(),rl=api.createInterface({input,output,terminal:false});
      try {
        const controller=new AbortController();
        const aborted=rl.question('abort?',{signal:controller.signal}).catch((e:any)=>({name:e.name,code:e.code,cause:e.cause}));
        controller.abort('reason');const error=await aborted;
        const next=rl.question('next?');input.write('next answer\n');
        return {error,answer:await next};
      }finally{rl.close();input.destroy();output.destroy();}
    }
    expect(await run(fixture.create().promises)).toEqual(await run(promises));
  });
  it('iterates actual lines and iterator return leaves the interface owner open',async()=>{
    async function run(api:any){
      const input=new PassThrough(),rl=api.createInterface({input,terminal:false});
      try {
        const iterator=rl[Symbol.asyncIterator]();const first=iterator.next();input.write('one\ntwo\n');
        const value=await first;const returned=await iterator.return();const stillOpen=!rl.closed;
        return {value,returned,stillOpen};
      }finally{rl.close();input.destroy();}
    }
    expect(await run(fixture.create().api)).toEqual(await run(readline));
  });
  it('routes pause/resume and input errors through the actual interface lifecycle',async()=>{
    async function run(api:any){
      const input=new PassThrough(),rl=api.createInterface({input,terminal:false});const events:string[]=[];
      for(const name of ['pause','resume','close'])rl.on(name,()=>events.push(name));
      try {
        expect(rl.pause()).toBe(rl);const paused=input.isPaused();expect(rl.resume()).toBe(rl);
        const error=new Error('input failed');const observed=once(rl,'error');input.emit('error',error);
        const [actual]=await observed;rl.close();rl.close();
        return {paused,sameError:actual===error,events,errorListeners:input.listenerCount('error')};
      }finally{rl.close();input.destroy();}
    }
    expect(await run(fixture.create().api)).toEqual(await run(readline));
  });
  it('uses real key decoding/editing/history over an explicit terminal-stream control',()=>{
    function run(api:any){
      const input:any=new PassThrough(),output:any=new PassThrough(),writes:string[]=[],raw:boolean[]=[];
      input.isRaw=false;input.setRawMode=(mode:boolean)=>{raw.push(mode);input.isRaw=mode;};output.isTTY=true;output.columns=80;
      output.on('data',(c:Buffer)=>writes.push(`${c}`));const rl=api.createInterface({input,output,terminal:true,prompt:'> '});
      const lines:string[]=[];rl.on('line',(x:string)=>lines.push(x));
      try {rl.prompt();input.write('abc\x1b[D\x7fZ\n');return{lines,history:rl.history.slice(),writes,raw};}
      finally{rl.close();input.destroy();output.destroy();}
    }
    const term=process.env.TERM;process.env.TERM='xterm-256color';
    try{expect(run(fixture.create().api)).toEqual(run(readline));}
    finally{if(term===undefined)delete process.env.TERM;else process.env.TERM=term;}
  });
  it('retains prompt/history/completer/abort constructor validation',()=>{
    for(const options of [{history:1},{historySize:-1},{tabSize:0},{completer:1},{signal:{}},{escapeCodeTimeout:NaN}]){
      const input=new PassThrough();
      try {
        expect(failure(()=>fixture.create().api.createInterface({input,terminal:false,...options})))
          .toEqual(failure(()=>readline.createInterface({input,terminal:false,...options} as any)));
      }finally{input.destroy();}
    }
  });
});
