import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { create } = require('./fixtures/node-copy-file-platform.cjs');
const controls = require('./fixtures/node-copy-file-controls.cjs');
const target = JSON.parse(fs.readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
// Selected public wrappers with real target requests, not the guest JSAPI.
describe.skipIf(process.versions.node !== target.version)('copyFile public wrappers with native owners', () => {
  for (const [name, run] of Object.entries(controls) as [string, (candidate:unknown) => unknown][]) {
    it(name, async () => {
      expect(await run(create())).toEqual(await run({ api:fs, promises:fs.promises }));
    });
  }
});
