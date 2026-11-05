import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require=createRequire(import.meta.url);
const {create}=require('./fixtures/node-write-file-platform.cjs');
const {controls}=require('./fixtures/node-write-file-controls.cjs');
const target=JSON.parse(fs.readFileSync(new URL('../../packages/registry/node-compat/target.json',import.meta.url),'utf8'));
describe.skipIf(process.versions.node!==target.version)('callback whole-file writes over actual native dependencies',()=>{
  for(const [name,run] of Object.entries(controls) as [string,(api:unknown)=>unknown][])
    it(name,async()=>expect(await run(create())).toEqual(await run(fs)));
});
