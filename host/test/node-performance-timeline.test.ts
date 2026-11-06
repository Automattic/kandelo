import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as native from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { createNativeAdapter } from './fixtures/node-native-adapter.cjs';
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
  it('connects factories to the explicit native histogram dependency',()=>{
    const {api}=create();
    for(const name of ['createHistogram','createSlidingWindowHistogram','importHistogram','monitorEventLoopDelay'])
      expect(api[name]).toBe(native[name]);
    // This fixture supplies the actual native producer. Its lifecycle is a
    // dependency control, not evidence for Kandelo loop phases or JSAPI.
    const monitor=api.monitorEventLoopDelay({resolution:5});
    try {
      expect(monitor.countBigInt).toBe(0n);
      expect(monitor.disable()).toBe(false);
      expect(monitor.enable()).toBe(true);
      expect(monitor.enable()).toBe(false);
      expect(monitor.disable()).toBe(true);
      expect(monitor.disable()).toBe(false);
      monitor.reset(); expect(monitor.countBigInt).toBe(0n);
    } finally { monitor[Symbol.dispose](); }
  });
  it('routes histogram calls and direct clones through production native owners',()=>{
    const calls: unknown[] = [], value = {}, transfer = [], packet = {}, result = {};
    const adapter = createNativeAdapter({
      histogramOperation(...args: unknown[]) { calls.push(['histogram', ...args]); return result; },
      serializeMessage(input: unknown, list: unknown) {
        expect(input).toBe(value); expect(list).toBe(transfer);
        calls.push('write'); return packet;
      },
      deserializeMessage(input: unknown) {
        expect(input).toBe(packet); calls.push('read'); return value;
      },
    });
    expect(adapter.histogramOperation('count', value)).toBe(result);
    expect(adapter.cloneValue(value, transfer)).toBe(value);
    expect(calls).toEqual([['histogram', 'count', value], 'write', 'read']);
  });
  it('keeps unmeasured native capabilities as explicit failures',()=>{
    const {api}=create();
    for(const name of ['eventLoopUtilization'])
      expect(()=>api[name]()).toThrow(expect.objectContaining({code:'ERR_METHOD_NOT_IMPLEMENTED'}));
    expect(()=>api.performance.nodeTiming.nodeStart).toThrow(expect.objectContaining({code:'ERR_METHOD_NOT_IMPLEMENTED'}));
    expect(()=>api.performance.nodeTiming.uvMetricsInfo).toThrow(expect.objectContaining({code:'ERR_METHOD_NOT_IMPLEMENTED'}));
    expect(api.PerformanceObserver.supportedEntryTypes).toEqual(['dns','function','mark','measure','resource']);
  });
});
