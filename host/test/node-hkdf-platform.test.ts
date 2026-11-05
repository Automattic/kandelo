import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import * as crypto from 'node:crypto';
import {describe,expect,it} from 'vitest';
const require=createRequire(import.meta.url);
const {create}=require('./fixtures/node-kdf-platform.cjs');
const controls=require('./fixtures/node-hkdf-controls.cjs');
const target=JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json',import.meta.url),'utf8'));
// Unchanged public HKDF over actual native26 key/job/resource dependencies.
// Portable ncrypto and guest queue/bindings are separately accounted evidence.
describe.skipIf(process.versions.node!==target.version)('HKDF public source with native dependencies',()=>{
  for(const [name,run] of Object.entries(controls) as [string,(api:unknown)=>unknown][]){
    it(name,async()=>expect(await run(create())).toEqual(await run(crypto)));
  }
});
