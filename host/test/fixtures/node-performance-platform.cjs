'use strict';
const fs=require('node:fs'),path=require('node:path'),util=require('node:util'),os=require('node:os');
const nativePerf=require('node:perf_hooks');
const nativePerformance=nativePerf.performance;
const nativeNow=nativePerformance.now.bind(nativePerformance);
// These are real native Node dependency owners, not guest-engine substitutes
// for conformance. Run the controls with --expose-internals.
const event={eventTarget:require('internal/event_target'),require:name=>require(name)};
const source=fs.readFileSync(path.resolve(__dirname,'../../../third_party/node-core/node-core.js'),'utf8');
const factories=Function(source+';return {values:_createNodeValuesPlatform,perf:_createNodePerformanceObserverPlatform};')();
exports.event=event;
exports.create=function create(overrides={}) {
  const values=factories.values({process,Buffer,util,inspection:util,os,
    signals:os.constants.signals,getDOMException:()=>DOMException});
  return factories.perf({values,util,process,setImmediate,event,structuredClone,
    histogram:require('internal/histogram'),
    native:{performanceNow:nativeNow,performanceTimeOrigin:()=>nativePerformance.timeOrigin,
      ...overrides}});
};
// Explicit native dependency boundary for the actual candidate ELU module.
// This does not exercise Kandelo's ShellContext clock or its wait hooks.
exports.createWithLoopMetrics=function createWithLoopMetrics() {
  const binding=require('internal/test/binding').internalBinding('performance');
  const {getMilestoneTimestamp}=require('internal/perf/utils');
  const index=binding.constants.NODE_PERFORMANCE_MILESTONE_LOOP_START;
  return exports.create({performanceLoopState:()=>[
    binding.milestones[index],getMilestoneTimestamp(index),binding.loopIdleTime(),
  ]});
};
if(process.env.KANDELO_PERFORMANCE_TIMELINE_PRELOAD==='1') {
  const candidate=exports.create(),{api}=candidate;
  // Only the selected timeline classes/methods are substituted. Other native
  // perf_hooks exports remain native and are outside this control's claims.
  for(const name of ['Performance','PerformanceEntry','PerformanceMark','PerformanceMeasure',
    'PerformanceObserver','PerformanceObserverEntryList','PerformanceResourceTiming','performance','timerify'])
    nativePerf[name]=api[name];
  candidate.installGlobals(globalThis);
  require('node:module').syncBuiltinESMExports();
}
