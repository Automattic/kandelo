import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
const require = createRequire(import.meta.url);
const { create } = require('./fixtures/node-key-platform.cjs');
const { controls } = require('./fixtures/node-key-controls.cjs');
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
// Public upstream JS over actual native handles. Portable C++ and guest JSAPI
// owners are separate evidence; this fixture cannot establish either host.
describe.skipIf(process.versions.node !== target.version)('key wrappers with real native dependencies', () => {
  for (const [name, run] of Object.entries(controls) as [string, (api: unknown) => unknown][]) {
    it(name, () => expect(run(create())).toEqual(run({ ...crypto, isDeepStrictEqual })));
  }
});
