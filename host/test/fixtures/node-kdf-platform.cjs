'use strict';
const fs = require('node:fs'), path = require('node:path'), util = require('node:util'), os = require('node:os');
const savedGlobals = ['internalBinding', 'primordials'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
const { internalBinding } = require('internal/test/binding');
for (const [key, descriptor] of savedGlobals) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
}
const binding = internalBinding('crypto');
const source = fs.readFileSync(path.resolve(__dirname, '../../../third_party/node-core/node-core.js'), 'utf8');
const factories = Function(source + '; return { values: _createNodeValuesPlatform, digest: _createNodeCryptoDigest, kdf: _createNodeCryptoKdf };')();
const modes = new WeakMap();
const nativeRuns = { hkdf: binding.HKDFJob.prototype.run, pbkdf2: binding.PBKDF2Job.prototype.run, scrypt: binding.ScryptJob.prototype.run,
  argon2: binding.Argon2Job?.prototype.run };
const packet = value => ({ value });
const record = error => error === undefined ? undefined : Object.assign({ name: error.name, message: error.message }, error);
exports.create = function create() {
  const values = factories.values({ process, Buffer, util, inspection: util, os, signals: os.constants.signals,
    uv: { binding: internalBinding('uv') }, getDOMException: () => DOMException });
  let digestHelpers;
  factories.digest({ values, Buffer, types: util.types, native: {}, captureHelpers: helpers => { digestHelpers = helpers; } });
  return factories.kdf({ values, Buffer, digestHelpers, types: util.types,
    keys: require('internal/crypto/keys'), kMaxLength: require('node:buffer').kMaxLength,
    makeError: (errno, syscall) => new values.errors.UVException({ errno, syscall }),
    native: {
      argon2Supported: () => binding.Argon2Job !== undefined,
      createKdfJob(prototype, complete, mode, algorithm, password, salt, params) {
        try {
          const Job = algorithm === 'pbkdf2' ? binding.PBKDF2Job : algorithm === 'argon2' ? binding.Argon2Job : binding.ScryptJob;
          const job = algorithm === 'hkdf' ? new binding.HKDFJob(mode, params[0], password, salt, params[1], params[2]) :
            new Job(mode, password, salt, ...params);
          Object.setPrototypeOf(job, prototype);
          modes.set(job, { mode, algorithm, complete });
          return packet(job);
        } catch (error) { return { error: record(error) }; }
      },
      runKdfJob(job) {
        const { mode, algorithm, complete } = modes.get(job);
        if (mode === 0) {
          const callback = job.ondone;
          job.ondone = function(error, result) {
            job.ondone = callback;
            return complete.call(job, 0, algorithm, [record(error), result]);
          };
        }
        const result = nativeRuns[algorithm].call(job);
        return packet(result === undefined ? undefined : [record(result[0]), result[1]]);
      },
    },
  });
};
// Explicit native dependency boundary: real Node jobs/resource lifecycle/GC,
// not Kandelo's uncompiled OpenSSL work dispatch or guest JSAPI conversion.
if (process.env.KANDELO_KDF_PRELOAD === '1') {
  const crypto = require('node:crypto');
  Object.assign(crypto, exports.create());
  require('node:module').syncBuiltinESMExports();
}
