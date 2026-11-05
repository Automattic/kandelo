'use strict';
const assert=require('node:assert/strict'),native=require('node:util');
const candidate=require('./node-util-algorithms.cjs').create();
const scenario=process.argv[2];
function result(fn){try{return {value:fn()};}catch(e){return {name:e.name,code:e.code,message:e.message};}}
(async()=>{
 if(scenario==='parse'){
  for(const config of [
   {args:['-abc','--name=hello','tail'],strict:false,tokens:true},
   {args:['--no-color','--color','-v','-v'],options:{color:{type:'boolean',default:true},verbose:{type:'boolean',short:'v',multiple:true}},allowNegative:true,tokens:true},
   {args:['--','-x',''],allowPositionals:true,tokens:true},
   {args:['--key=','--key=two'],options:{key:{type:'string',multiple:true,default:['one']}}},
   {args:[],options:{x:{type:'string',default:'x'},y:{type:'boolean',default:false}}},
   {args:['--__proto__=bad','--constructor=x'],strict:false},
   {args:['-abvalue'],options:{a:{type:'boolean'},b:{type:'string'}},tokens:true},
   Object.assign(Object.create({strict:false}),{args:['--missing']})
  ])assert.deepEqual(result(()=>candidate.parseArgs(config)),result(()=>native.parseArgs(config)));
  const parsed=candidate.parseArgs({args:['--x'],strict:false});assert.equal(Object.getPrototypeOf(parsed.values),null);
 }else if(scenario==='parse-errors'){
  for(const config of [null,[],{args:'x'},{args:[1]},{args:['--unknown']},{args:['positional']},{args:['--x'],options:{x:{type:'string'}}},{args:['--x=bad'],options:{x:{type:'boolean'}}},{args:[],options:{x:{type:'bad'}}},{args:[],allowNegative:1},{args:[],options:{x:{type:'boolean',short:'ab'}}},{args:[],options:{x:{type:'string',multiple:true,default:'x'}}}])
   assert.deepEqual(result(()=>candidate.parseArgs(config)),result(()=>native.parseArgs(config)));
 }else if(scenario==='defaults'){
  const argv=process.argv,exec=process.execArgv;
  try{process.argv=['owned-node','owned-script','--one','tail'];process.execArgv=['-e','fake'];
   assert.deepEqual(candidate.parseArgs({strict:false,tokens:true}),native.parseArgs({strict:false,tokens:true}));
  }finally{process.argv=argv;process.execArgv=exec;}
 }else if(scenario==='diff'){
  for(const [a,b] of [['abc','adc'],['\ud800x','\ud801y'],['',''],[['a','b','c'],['a','x','c']],['abc',['a','b','c']],[null,null],[false,false],[null,'x'],[[1],['x']]])
   assert.deepEqual(result(()=>candidate.diff(a,b)),result(()=>native.diff(a,b)));
 }else if(scenario==='debounce'){
  for(const api of [candidate,native]){
   let calls=0;const d=api.debounce(function(value){calls++;assert.equal(this,d);return value;},50);
   const first=d(1),last=d(2);assert.equal(d.pending,last);assert.equal(d.ref(),d);assert.equal(d.unref(),d);assert.equal(d.ref(),d);
   d.flush();assert.deepEqual(await Promise.all([first,last]),[2,2]);assert.equal(calls,1);assert.equal(d.pending,null);
   const promise=d(3);d.cancel('stop');await assert.rejects(promise,error=>error.code==='ABORT_ERR'&&error.cause==='stop');
  }
 }else if(scenario==='throttle'){
  for(const api of [candidate,native]){
   let release;const gate=new Promise(resolve=>release=resolve),seen=[];
   const t=api.throttle(async function(value){assert.equal(this,t);seen.push(value);await gate;return value;},1,0,{concurrency:1});
   const first=t(1),second=t(2);assert.deepEqual(seen,[1]);assert.equal(t.pendingCount,1);assert.equal(t.activeCount,1);assert.equal(t.pending,second);
   release();assert.deepEqual(await Promise.all([first,second]),[1,2]);assert.deepEqual(seen,[1,2]);assert.equal(t.pendingCount,0);
   assert.equal(t.unref(),t);assert.equal(t.ref(),t);
  }
 }else if(scenario==='properties'){
  for(const key of ['parseArgs','diff','debounce','throttle']){
   const fn=candidate[key],expected=native[key];assert.equal(fn.name,expected.name);assert.equal(fn.length,expected.length);
   const actual=Object.getOwnPropertyDescriptor(candidate,key),reference=Object.getOwnPropertyDescriptor(native,key);
   for(const name of ['writable','enumerable','configurable'])assert.equal(actual[name],reference[name]);
  }
  const frozen=Object.freeze(require('./node-util-algorithms.cjs').create());
  assert.deepEqual(frozen.parseArgs({args:[]}),native.parseArgs({args:[]}));assert.deepEqual(frozen.diff('a','b'),native.diff('a','b'));
 }else if(scenario==='abort'){
  for(const api of [candidate,native]){
   const controller=new AbortController(),d=api.debounce(()=>assert.fail('Aborted invocation'),100,{signal:controller.signal});
   const promise=d();controller.abort('stop');await assert.rejects(promise,error=>error.code==='ABORT_ERR'&&error.cause==='stop');
   await assert.rejects(d(),error=>error.code==='ABORT_ERR'&&error.cause==='stop');
   for(const name of ['debounce','throttle'])assert.throws(()=>name==='debounce'?api[name](()=>{},1,{signal:controller.signal}):api[name](()=>{},1,1,{signal:controller.signal}),{code:'ABORT_ERR'});
  }
 }else throw Error('Unknown control '+scenario);
 console.log(JSON.stringify({scenario,passed:true}));
})().catch(error=>{console.error(error);process.exitCode=1;});
