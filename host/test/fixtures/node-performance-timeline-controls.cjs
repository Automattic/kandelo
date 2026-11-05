'use strict';
const assert=require('node:assert/strict');
const invalid=fn=>{try{fn();return {unexpectedSuccess:true};}catch(e){return {name:e.name,code:e.code,message:e.message};}};
function clean(api){api.performance.clearMarks();api.performance.clearMeasures();api.performance.clearResourceTimings();}
function info(start=2){return {startTime:start,endTime:start+10,finalServiceWorkerStartTime:0,
  redirectStartTime:0,redirectEndTime:0,postRedirectStartTime:start,finalNetworkRequestStartTime:start+1,
  finalNetworkResponseStartTime:start+3,firstInterimNetworkResponseStartTime:start+2,
  encodedBodySize:40,decodedBodySize:60,finalConnectionTimingInfo:{domainLookupStartTime:3,domainLookupEndTime:4,
    connectionStartTime:4,connectionEndTime:5,secureConnectionStartTime:4,ALPNNegotiatedProtocol:'h2'},renderBlocking:true};}
exports.controls={
  marksMeasuresCloneAndBuffer(api){
    clean(api);const p=api.performance;
    try{
      const detail={array:[1],bytes:new Uint8Array([2,3])};detail.self=detail;
      const a=p.mark('a',{startTime:10,detail});detail.array[0]=9;
      assert.notEqual(a.detail,detail);assert.equal(a.detail.self,a.detail);assert.equal(a.detail.array[0],1);
      assert(a instanceof api.PerformanceMark);assert(a instanceof api.PerformanceEntry);
      p.mark('b',{startTime:30});p.mark('a',{startTime:12});
      const m=p.measure('span','a','b');assert.equal(m.startTime,12);assert.equal(m.duration,18);
      const n=p.measure('explicit',{start:5,duration:7,detail:{x:1}});
      assert(n instanceof api.PerformanceMeasure);
      const entries=p.getEntries().map(e=>[e.name,e.entryType,e.startTime,e.duration]);
      const copy=p.getEntriesByType('mark');copy.length=0;assert.equal(p.getEntriesByType('mark').length,3);
      p.clearMarks('a');assert.equal(p.getEntriesByName('a').length,0);
      const missing=invalid(()=>p.measure('missing','a','b'));
      p.clearMeasures();assert.equal(p.getEntriesByType('measure').length,0);
      return {entries,missing,detail:[a.detail.array[0],...a.detail.bytes],measure:n.toJSON()};
    }finally{clean(api);}
  },
  validationAndFailedCloneIndex(api){
    clean(api);const p=api.performance;
    try{
      const results=[invalid(()=>p.mark()),invalid(()=>p.measure()),invalid(()=>p.mark('nodeStart')),
        invalid(()=>p.mark('x',{startTime:-1})),invalid(()=>p.measure(1)),
        invalid(()=>p.measure('x',{start:1,end:2,duration:1})),
        invalid(()=>p.measure('x',{start:1},'end')),invalid(()=>p.getEntriesByName()),
        invalid(()=>p.getEntriesByType()),invalid(()=>p.clearMarks('loopStart'))];
      const error=invalid(()=>p.mark('clone-failed',{startTime:25,detail:()=>{}}));
      assert.equal(error.name,'DataCloneError');assert.equal(p.getEntriesByName('clone-failed').length,0);
      const m=p.measure('after-failure','clone-failed',30);
      results.push({cloneErrorName:error.name,start:m.startTime,duration:m.duration});return results;
    }finally{clean(api);}
  },
  observersAndBufferedReplay:async function(api){
    clean(api);let observer;const p=api.performance;
    try{
      let returned=false;
      const entries=await new Promise((resolve,reject)=>{
        observer=new api.PerformanceObserver((list,self)=>{try{
          assert(returned);assert.equal(self,observer);
          const rows=list.getEntries().map(e=>[e.name,e.entryType,e.startTime,e.duration]);
          const copy=list.getEntries();copy.length=0;assert.equal(list.getEntries().length,3);resolve(rows);
        }catch(e){reject(e);}});
        observer.observe({entryTypes:['mark','measure']});
        p.mark('later',{startTime:20});p.mark('earlier',{startTime:5});p.measure('interval','earlier','later');returned=true;
      });observer.disconnect();
      const replay=await new Promise((resolve,reject)=>{
        observer=new api.PerformanceObserver(list=>{try{resolve(list.getEntries().map(e=>e.name));}catch(e){reject(e);}});
        observer.observe({type:'mark',buffered:true});
      });observer.disconnect();
      observer=new api.PerformanceObserver(()=>assert.fail('disconnected callback'));
      observer.observe({type:'mark'});p.mark('taken',{startTime:40});
      const taken=observer.takeRecords().map(e=>e.name);observer.disconnect();
      return {entries,replay,taken};
    }finally{observer?.disconnect();clean(api);}
  },
  resourceFieldsAndOverflow:async function(api){
    clean(api);const p=api.performance,timing=info(),body={contentType:'text/plain',contentEncoding:'gzip'};
    let listener;
    try{
      const resource=p.markResourceTiming(timing,'https://example.test/a','fetch',globalThis,'',body,201,'cache');
      assert(resource instanceof api.PerformanceResourceTiming);assert(resource instanceof api.PerformanceEntry);
      timing.endTime=25;body.contentType='application/json';
      const result=resource.toJSON();assert.equal(result.duration,23);assert.equal(result.contentType,'application/json');
      assert.equal(p.getEntriesByType('resource')[0],resource);p.clearResourceTimings();p.setResourceTimingBufferSize(1);
      const overflow=await new Promise((resolve,reject)=>{
        listener=event=>{try{assert.equal(event.target,p);assert.equal(event.type,'resourcetimingbufferfull');resolve(true);}catch(e){reject(e);}};
        p.addEventListener('resourcetimingbufferfull',listener,{once:true});
        p.markResourceTiming(info(10),'first','fetch',globalThis,'local');
        p.markResourceTiming(info(20),'overflow','fetch',globalThis,'');
      });
      assert.equal(p.getEntriesByType('resource').length,1);
      return {result,overflow,names:p.getEntriesByType('resource').map(e=>e.name)};
    }finally{if(listener)p.removeEventListener('resourcetimingbufferfull',listener);p.setResourceTimingBufferSize(250);clean(api);}
  },
  timerifyCallsConstructorsAndPromises:async function(api){
    let observer;const p=api.performance;const details=[];
    try{
      const delivered=new Promise((resolve,reject)=>{
        observer=new api.PerformanceObserver(list=>{try{
          for(const e of list.getEntries()){
            assert.equal(e.entryType,'function');assert(e.duration>=0);assert(e.startTime>=0);
            details.push([e.name,e.detail,e[0]]);
          }
          if(details.length===3)resolve();
        }catch(e){reject(e);}});observer.observe({type:'function'});
      });
      function sum(a,b){return this.base+a+b;}
      const wrapped=p.timerify(sum),answer=wrapped.call({base:10},2,3);
      assert.equal(answer,15);assert.equal(wrapped.name,'timerified sum');assert.equal(wrapped.length,2);
      class Sample{constructor(value){this.value=value;}}
      const make=api.timerify(Sample),instance=new make(7);assert(instance instanceof Sample);assert.equal(instance.value,7);
      async function asyncValue(value){return value+1;}
      assert.equal(await p.timerify(asyncValue)(8),9);
      const error=new Error('original');assert.throws(()=>p.timerify(()=>{throw error;})(),e=>e===error);
      await delivered;
      return {answer,value:instance.value,details:details.sort((a,b)=>a[0].localeCompare(b[0]))};
    }finally{observer?.disconnect();}
  },
  brandsDescriptorsAndGlobals(api,install){
    const p=api.performance,errors=[];
    for(const name of ['Performance','PerformanceEntry','PerformanceMeasure','PerformanceResourceTiming'])
      errors.push(invalid(()=>new api[name]()));
    errors.push(invalid(()=>p.now.call({})),invalid(()=>p.mark.call({},'x')));
    const proto=Object.getPrototypeOf(p),method=Object.getOwnPropertyDescriptor(proto,'mark');
    const root={};install(root);assert.equal(root.performance,p);assert.equal(root.PerformanceMark,api.PerformanceMark);
    const descriptor=Object.getOwnPropertyDescriptor(root,'performance');root.performance=undefined;assert.equal(root.performance,undefined);
    root.performance=123;assert.equal(root.performance,123);
    return {errors,tag:Object.prototype.toString.call(p),eventTarget:p instanceof EventTarget,
      method:[method.enumerable,method.writable,method.configurable,method.value.name,method.value.length],
      global:[descriptor.enumerable,descriptor.configurable,descriptor.get.name,descriptor.set.name]};
  },
};
