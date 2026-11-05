import { createRequire, SourceMap as NativeSourceMap } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const require=createRequire(import.meta.url);
const {create}=require('./fixtures/node-source-map-platform.cjs');
const {controls}=require('./fixtures/node-source-map-controls.cjs');
const target=JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json',import.meta.url),'utf8'));
describe.skipIf(process.versions.node!==target.version)('public SourceMap over pinned algorithms',()=>{
  for(const [name,run] of Object.entries(controls) as [string,(Ctor:unknown)=>unknown][])
    it(name,()=>expect(run(create().SourceMap)).toEqual(run(NativeSourceMap)));
  it('installs on the actual bootstrap Module owner and both builtin spellings',()=>{
    const actual=require('./fixtures/node-module-records.cjs').create();
    const Module=actual.Module,requireFrom=actual.make('/source-map-entry.cjs');
    expect(Module.SourceMap.name).toBe('SourceMap');
    expect(Module.Module).toBe(Module);
    expect(requireFrom('node:module').SourceMap).toBe(Module.SourceMap);
    expect(requireFrom('module').SourceMap).toBe(Module.SourceMap);
    const descriptor=Object.getOwnPropertyDescriptor(Module,'SourceMap')!;
    const expected=Object.getOwnPropertyDescriptor(require('node:module'),'SourceMap')!;
    expect([descriptor.enumerable,descriptor.configurable,descriptor.writable])
      .toEqual([expected.enumerable,expected.configurable,expected.writable]);
    expect(new Module.SourceMap({sources:['original.js'],mappings:'AAAA'}).findOrigin(1,1))
      .toEqual(new NativeSourceMap({sources:['original.js'],mappings:'AAAA'}).findOrigin(1,1));
  });
});
