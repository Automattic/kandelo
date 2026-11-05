import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require=createRequire(import.meta.url);
const {create}=require('./fixtures/node-realpath-platform.cjs');
const controls=require('./fixtures/node-realpath-controls.cjs');
const target=JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json',import.meta.url),'utf8'));
describe.skipIf(process.versions.node!==target.version)('pinned realpath/readlink over actual native I/O',()=>{
 for(const [name,run]of Object.entries(controls) as [string,(owner:unknown)=>unknown][])
  it(name,async()=>{const [candidate,native]=await controls.compare(run,create(),{api:fs,promises:fs.promises});expect(candidate).toEqual(native);});
});
