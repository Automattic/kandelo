import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require=createRequire(import.meta.url);
const { create }=require('./fixtures/node-path-metadata-platform.cjs');
const controls=require('./fixtures/node-path-metadata-controls.cjs');
const target=JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json',import.meta.url),'utf8'));
// Real native requests and filesystem dependencies; not the new guest bridge.
describe.skipIf(process.versions.node!==target.version)('pathname metadata with native owners',()=>{
  for(const [name,run] of Object.entries(controls) as [string,(candidate:unknown)=>unknown][]) {
    it(name,async()=>{expect(await run(create())).toEqual(await run({api:fs,promises:fs.promises}));});
  }
});
