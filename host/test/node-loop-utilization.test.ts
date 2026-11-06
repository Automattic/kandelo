import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as native from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { createWithLoopMetrics } = require('./fixtures/node-performance-platform.cjs');
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
// Full candidate ELU arithmetic over native Node measurement dependencies.
// Portable clock and actual guest/host integration are separate evidence.
describe.skipIf(process.versions.node !== target.version)('event loop utilization with native measurement dependencies', () => {
  it('shares the public function and its descriptors', () => {
    const { api } = createWithLoopMetrics();
    expect(api.eventLoopUtilization).toBe(api.performance.eventLoopUtilization);
    const shape = (fn: Function) => ({name:fn.name,length:fn.length,
      prototype:Object.getOwnPropertyDescriptor(fn,'prototype')?.writable,
      keys:Reflect.ownKeys(fn)});
    expect(shape(api.eventLoopUtilization)).toEqual(shape(native.eventLoopUtilization));
  });
  it('preserves exact two-snapshot arithmetic, coercion and getter order', () => {
    const { api } = createWithLoopMetrics();
    function run(elu: Function) {
      const trace: string[] = [];
      const snapshot = (name:string, idle:unknown, active:unknown) => ({
        get idle(){trace.push(name+'.idle');return idle;},
        get active(){trace.push(name+'.active');return active;},
      });
      const results = [
        elu(snapshot('a',5,10),snapshot('b',2,3)),
        elu({idle:0,active:0},{idle:0,active:0}),
        elu({idle:-5,active:10},{idle:2,active:-3}),
        elu({idle:'5',active:'8'},{idle:'1',active:'2'}),
        elu({},{}),
      ];
      return {results,trace};
    }
    expect(run(api.eventLoopUtilization)).toEqual(run(native.eventLoopUtilization));
  });
  it('preserves snapshot getter errors and receiver independence', () => {
    const { api } = createWithLoopMetrics();
    for(const elu of [api.eventLoopUtilization,native.eventLoopUtilization]) {
      const sentinel = new Error('snapshot getter');
      expect(()=>elu({get idle(){throw sentinel;}},{})).toThrow(sentinel);
      expect(elu.call(null,{idle:5,active:10},{idle:2,active:3}))
        .toEqual({idle:3,active:7,utilization:0.7});
    }
  });
  it('uses live loop-start and idle measurements for cumulative and delta modes', async () => {
    const { api } = createWithLoopMetrics();
    expect(api.performance.nodeTiming.loopStart).toBe(native.performance.nodeTiming.loopStart);
    const before = api.eventLoopUtilization();
    await new Promise(resolve=>setTimeout(resolve,15));
    const referenceBefore = native.eventLoopUtilization();
    const measured = api.eventLoopUtilization();
    const referenceAfter = native.eventLoopUtilization();
    expect(measured.idle).toBe(referenceBefore.idle);
    expect(measured.idle).toBe(referenceAfter.idle);
    expect(measured.idle).toBeGreaterThanOrEqual(before.idle);
    expect(measured.active).toBeGreaterThanOrEqual(referenceBefore.active);
    expect(measured.active).toBeLessThanOrEqual(referenceAfter.active);
    expect(measured.utilization).toBe(measured.active/(measured.idle+measured.active));
    expect(api.performance.nodeTiming.idleTime).toBe(measured.idle);
    const delta = api.eventLoopUtilization(measured,before);
    expect(delta).toEqual({idle:measured.idle-before.idle,active:measured.active-before.active,
      utilization:(measured.active-before.active)/(measured.idle-before.idle+measured.active-before.active)});
  });
  it('reads the worker loop from its actual independent native owner', async () => {
    const fixture = require.resolve('./fixtures/node-performance-platform.cjs');
    const worker = new Worker(`
      const {parentPort}=require('node:worker_threads');
      const native=require('node:perf_hooks');
      const {api}=require(${JSON.stringify(fixture)}).createWithLoopMetrics();
      const before=native.eventLoopUtilization();
      const value=api.eventLoopUtilization();
      const after=native.eventLoopUtilization();
      parentPort.postMessage({started:api.performance.nodeTiming.loopStart>=0,
        active:value.active>=before.active&&value.active<=after.active,
        idle:value.idle===before.idle&&value.idle===after.idle,
        finite:Number.isFinite(value.utilization)});
    `,{eval:true});
    try {
      const result=await new Promise((resolve,reject)=>{
        worker.once('message',resolve);worker.once('error',reject);
        worker.once('exit',code=>{if(code)reject(new Error('Worker exit '+code));});
      });
      expect(result).toEqual({started:true,active:true,idle:true,finite:true});
    } finally { await worker.terminate(); }
  });
  it('counts blocking synchronous work as active without adding idle time', () => {
    const { api } = createWithLoopMetrics();
    const before = api.eventLoopUtilization();
    const begin = native.performance.now();
    while(native.performance.now()-begin<10) {}
    const delta = api.eventLoopUtilization(before);
    expect(delta.idle).toBe(0); expect(delta.active).toBeGreaterThanOrEqual(9);
    expect(delta.utilization).toBe(1);
  });
});
