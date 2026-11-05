import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as native from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
const require=createRequire(import.meta.url);
const {create}=require('./fixtures/node-performance-platform.cjs');
const {controls}=require('./fixtures/node-performance-timeline-controls.cjs');
const target=JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json',import.meta.url),'utf8'));
describe.skipIf(process.versions.node!==target.version)('Performance timeline with native dependencies',()=>{
  for(const [name,run] of Object.entries(controls) as [string,(api:unknown,install:Function)=>unknown][]) {
    it(name,async()=>{
      const candidate=create();
      const installNative=(root:Record<string,unknown>)=>{
        const descriptor=Object.getOwnPropertyDescriptor(globalThis,'performance')!;
        Object.defineProperty(root,'performance',descriptor);
        root.PerformanceMark=native.PerformanceMark;
      };
      expect(await run(candidate.api,candidate.installGlobals)).toEqual(await run(native,installNative));
    });
  }
  it('keeps unmeasured native capabilities as explicit failures',()=>{
    const {api}=create();
    for(const name of ['monitorEventLoopDelay','createHistogram','createSlidingWindowHistogram','importHistogram','eventLoopUtilization'])
      expect(()=>api[name]()).toThrow(expect.objectContaining({code:'ERR_METHOD_NOT_IMPLEMENTED'}));
    expect(()=>api.performance.nodeTiming.nodeStart).toThrow(expect.objectContaining({code:'ERR_METHOD_NOT_IMPLEMENTED'}));
    expect(()=>api.performance.nodeTiming.uvMetricsInfo).toThrow(expect.objectContaining({code:'ERR_METHOD_NOT_IMPLEMENTED'}));
    expect(api.PerformanceObserver.supportedEntryTypes).toEqual(['dns','function','mark','measure','resource']);
  });
});
