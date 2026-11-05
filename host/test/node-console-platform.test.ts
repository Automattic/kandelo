import { createRequire } from 'node:module';
import { Console as NativeConsole } from 'node:console';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const fixture = require('./fixtures/node-console-platform.cjs');
const target = require('../../packages/registry/node-compat/target.json');
function failure(fn:()=>unknown) {try {fn();}catch(e:any){return {name:e.name,code:e.code,message:e.message};}}
function sinks() {
  const out:string[]=[],err:string[]=[];
  const make=(records:string[])=>new Writable({write(chunk,_encoding,done){records.push(chunk.toString());done();}});
  const stdout=make(out),stderr=make(err);
  return {stdout,stderr,out,err,close(){stdout.destroy();stderr.destroy();}};
}
describe.skipIf(process.versions.node !== target.version)('pinned Console stream and state owners',()=>{
  it('matches constructor overloads, validation, inherited overrides and bound methods',()=>{
    const owner=fixture.create(),io=sinks();
    try {
      for(const options of [undefined,{},null,{stdout:io.stdout,colorMode:'invalid'},
        {stdout:io.stdout,groupIndentation:-1},{stdout:io.stdout,groupIndentation:1001},
        {stdout:io.stdout,inspectOptions:3},{stdout:io.stdout,colorMode:true,inspectOptions:{colors:false}}])
        expect(failure(()=>new owner.api.Console(options))).toEqual(failure(()=>new NativeConsole(options as any)));
      function run(Base:any) {
        class Sub extends Base {log(value:any){return 'override:'+value;}}
        const c=new Sub(io.stdout,io.stderr,false),bound=c.log;
        return [bound('value'),c instanceof Base,c instanceof Sub,c.log.name,c.warn.name];
      }
      expect(run(owner.api.Console)).toEqual(run(NativeConsole));
    }finally{owner.close();io.close();}
  });
  it('installs the actual namespace with pinned descriptors and lazy stream identity',()=>{
    const owner=fixture.create(),target={};
    try {
      owner.install(target);const descriptor=Object.getOwnPropertyDescriptor(target,'console')!;
      expect(descriptor).toEqual({value:owner.api,writable:true,enumerable:false,configurable:true});
      expect(owner.api instanceof owner.api.Console).toBe(true);
      expect(Object.getPrototypeOf(Object.getPrototypeOf(owner.api))).toBe(Object.prototype);
      expect(Object.prototype.toString.call(owner.api)).toBe('[object console]');
      expect(owner.api._stdout).toBe(owner.stdout);expect(owner.api._stderr).toBe(owner.stderr);
      const log=owner.api.log;log('bound %d',7);expect(owner.out).toEqual(['bound 7\n']);
    }finally{owner.close();}
  });
  it('matches formatting, per-stream inspect maps, tables and assertions',()=>{
    const owner=fixture.create();
    function run(Base:any) {
      const io=sinks();try {
        const inspectOptions=new Map([[io.stdout,{depth:0,colors:false}],[io.stderr,{depth:2,colors:false}]]);
        const c=new Base({stdout:io.stdout,stderr:io.stderr,inspectOptions});
        c.log('%s %d %j %%','name',3,{a:1});c.dir({a:{b:{c:1}}});
        c.warn({a:{b:{c:1}}});c.table([{a:1,b:'two'},{a:2,b:'three'}],['a']);
        c.table(new Map([['key',1]]));c.table(new Set([1,2]).values());
        c.assert(true,'hidden');c.assert(false,'failed %d',4);
        return {out:io.out,err:io.err};
      }finally{io.close();}
    }
    try{expect(run(owner.api.Console)).toEqual(run(NativeConsole));}finally{owner.close();}
  });
  it('owns independent counts, resets and nested multiline group indentation',()=>{
    const owner=fixture.create();
    function run(Base:any) {
      const io=sinks();try {
        const c=new Base({stdout:io.stdout,stderr:io.stderr,colorMode:false,groupIndentation:3});
        c.count();c.count('x');c.count('x');c.countReset('x');c.count('x');
        c.group('first');c.log('a\nb');c.groupCollapsed('second');c.warn('nested');
        c.groupEnd();c.groupEnd();c.groupEnd();c.log('end');
        return {out:io.out,err:io.err};
      }finally{io.close();}
    }
    try{expect(run(owner.api.Console)).toEqual(run(NativeConsole));
      owner.api.countReset('absent');expect(owner.warnings).toEqual([["Count for 'absent' does not exist"]]);
    }finally{owner.close();}
  });
  it('uses the monotonic timer dependency and preserves duplicate/missing label warnings',()=>{
    const original=process.hrtime;
    let now=0n;
    const clock:any=(start?:[number,number])=>{
      const elapsed=now-(start?BigInt(start[0])*1000000000n+BigInt(start[1]):0n);
      return [Number(elapsed/1000000000n),Number(elapsed%1000000000n)];
    };
    clock.bigint=()=>now;
    const owner=fixture.create({hrtime:clock});
    function run(c:any) {now=1000000000n;c.time('work');now+=1234567n;c.timeLog('work','part');now+=2000000000n;c.timeEnd('work');}
    const io=sinks();try {
      const native=new NativeConsole({stdout:io.stdout,stderr:io.stderr,colorMode:false});
      process.hrtime=clock;run(native);run(owner.api);
      expect(owner.out).toEqual(io.out);
      owner.api.time('same');owner.api.time('same');owner.api.timeEnd('missing');
      expect(owner.warnings).toEqual([["Label 'same' already exists for console.time()"],["No such label 'missing' for console.timeEnd()"]]);
    }finally{process.hrtime=original;owner.close();io.close();}
  });
  it('preserves actual stream failures and releases its temporary error listener',()=>{
    const owner=fixture.create(),failure=Error('write failure');
    function run(Base:any) {
      const io=sinks();try {
        io.stdout.write=(()=>{throw failure;}) as any;
        const loud=new Base({stdout:io.stdout,ignoreErrors:false});
        let same=false;try{loud.log('value');}catch(e){same=e===failure;}
        const quiet=new Base({stdout:io.stdout,ignoreErrors:true});quiet.log('value');
        return [same,io.stdout.listenerCount('error')];
      }finally{io.close();}
    }
    try{expect(run(owner.api.Console)).toEqual(run(NativeConsole));}finally{owner.close();}
  });
  it('uses actual engine stacks with a truthful missing-capture fallback',()=>{
    for(const noCapture of [false,true]) {
      const owner=fixture.create({noCapture});try {
        function actualCaller(){owner.api.trace('trace %d',7);}actualCaller();
        expect(owner.err).toHaveLength(1);expect(owner.err[0]).toMatch(/^Trace: trace 7\n/);
        expect(owner.err[0]).toContain('actualCaller');
      }finally{owner.close();}
    }
  });
  it('clears a terminal stream using the pinned cursor controls',()=>{
    const owner=fixture.create(),original=process.env.TERM;
    function run(Base:any) {
      const io=sinks();try{Object.defineProperty(io.stdout,'isTTY',{value:true});
        const c=new Base({stdout:io.stdout});c.clear();return io.out;
      }finally{io.close();}
    }
    try{process.env.TERM='xterm';owner.process.env.TERM='xterm';
      expect(run(owner.api.Console)).toEqual(run(NativeConsole));
    }finally{if(original===undefined)delete process.env.TERM;else process.env.TERM=original;owner.close();}
  });
  it('records only active internal trace subscriptions and retires reentrant collectors',()=>{
    const owner=fixture.create(),events:any[]=[];try {
      expect(owner.traceBinding.isTraceCategoryEnabled('node,node.console')).toBe(false);
      owner.api.count('disabled');expect(events).toEqual([]);
      const collector=owner.collect(['node.console'],(record:any)=>events.push(record));
      expect(owner.traceBinding.isTraceCategoryEnabled('node,node.console')).toBe(true);
      owner.api.time('duration');owner.api.timeLog('duration');owner.api.timeEnd('duration');
      expect(events.map(e=>e.phase)).toEqual([98,110,101]);
      expect(events.every(e=>typeof e.timestamp==='bigint'&&Object.isFrozen(e))).toBe(true);
      expect(events[1].timestamp>=events[0].timestamp).toBe(true);
      collector.stop();collector.stop();const before=events.length;owner.api.time('after');owner.api.timeEnd('after');
      expect(events).toHaveLength(before);
      const calls:string[]=[];let second:any;
      const first=owner.collect(['custom'],()=>{calls.push('first');second.stop();});
      second=owner.collect(['custom'],()=>calls.push('second'));
      owner.traceBinding.trace(1,'custom','event',0);expect(calls).toEqual(['first']);first.stop();
    }finally{owner.close();}
  });
});
