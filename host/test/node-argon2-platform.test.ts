import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require=createRequire(import.meta.url);
const {create}=require('./fixtures/node-kdf-platform.cjs');
const {controls}=require('./fixtures/node-argon2-controls.cjs');
const target=JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json',import.meta.url),'utf8'));
// Real native KDF requests and async hooks replace the uncompiled guest bridge.
describe.skipIf(process.versions.node!==target.version)('Argon2 public source with native dependencies',()=>{
  for(const [name,run] of Object.entries(controls) as [string,(api:unknown)=>unknown][]) {
    it(name,async()=>expect(await run(create())).toEqual(await run(crypto)));
  }
});
