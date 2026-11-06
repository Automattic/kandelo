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
  it('keeps JWK material off mutable JavaScript codec callbacks', () => {
    const candidate = create({ forbidJwkCodecCallbacks: true });
    const base = new URL('../../.context/nodejs-lts-cache-v2/node-v26.13.0/test/fixtures/keys/', import.meta.url);
    for (const file of ['rsa_private.pem', 'ec_p256_private.pem', 'ed25519_private.pem']) {
      const reference = crypto.createPrivateKey(readFileSync(new URL(file, base)));
      const jwk = reference.export({ format: 'jwk' });
      expect(candidate.createPrivateKey({ key: jwk, format: 'jwk' }).export({ format: 'jwk' }))
        .toEqual(reference.export({ format: 'jwk' }));
      expect(candidate.createPublicKey({ key: jwk, format: 'jwk' }).export({ format: 'jwk' }))
        .toEqual(crypto.createPublicKey(reference).export({ format: 'jwk' }));
    }
    expect(candidate.createSecretKey(new Uint8Array([1])).export({ format: 'jwk' }))
      .toEqual({ kty: 'oct', k: 'AQ' });
  });
  for (const [name, run] of Object.entries(controls) as [string, (api: unknown) => unknown][]) {
    it(name, () => expect(run(create())).toEqual(run({ ...crypto, isDeepStrictEqual })));
  }
});
