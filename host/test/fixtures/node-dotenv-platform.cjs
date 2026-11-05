'use strict';
// Actual shared public wrappers and (when selected) the compiled portable
// parser/file owner. JSAPI and environment application are explicit controls.
const fs = require('node:fs'), path = require('node:path'), util = require('node:util');
const { fileURLToPath } = require('node:url');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, 'third_party/node-core/node-core.js'), 'utf8');
const factories = Function(source + ';return { values:_createNodeValuesPlatform, stats:_createNodeFsStats, uv:_createNodeUvPlatform, publicUtil:_createNodePublicUtil, dotenv:_createNodeDotenvPlatform };')();
const environment = process.env;
const loadEnvFile = process.loadEnvFile.bind(process), parseEnv = util.parseEnv;
exports.record = function record(entries) {
  const object = Object.create(null);
  for (const [key, value] of entries) Object.defineProperty(object, Buffer.from(key, 'hex').toString('utf8'), {
    value: Buffer.from(value, 'hex').toString('utf8'), writable: true, enumerable: true, configurable: true,
  });
  return object;
};
exports.create = function create() {
  const uv = factories.uv({ native: { getUvErrorData: () => [...util.getSystemErrorMap()]
    .map(([number, [name, message]]) => [number, name, message]) } });
  const values = factories.values({ process, Buffer, util, uv, inspection: util,
    os: require('node:os'), signals: require('node:os').constants.signals, getDOMException: () => DOMException });
  const utils = factories.stats({ fs, process, Buffer, types: util.types, values,
    truncation: { vfsState: { handlers: null } }, native: {}, permissionEnabled: () => false,
    toPathIfFileURL: value => value instanceof URL ? fileURLToPath(value) : value });
  const helper = process.env.KANDELO_DOTENV_NATIVE_HELPER;
  function run(args, input) { return JSON.parse(execFileSync(helper, args, { input, encoding: 'utf8' })); }
  const calls = [];
  const native = {
    parseEnv(content) {
      calls.push(['parseEnv']);
      return helper ? exports.record(run([], Buffer.from(content)).entries) : parseEnv(content);
    },
    loadEnvFile(file) {
      calls.push(['loadEnvFile', file]);
      if (helper) {
        const result = run([file]);
        if (result.failure) return { kind: ['none', 'open', 'read', 'close'][result.failure],
          errno: -result.error, path: `${file}` };
        // Controlled native environment boundary for ordinary tested names.
        // Engine raw-key lookup/UTF-8/NUL and allocation/locking are not tested.
        for (const [key, value] of Object.entries(exports.record(result.entries))) {
          if (environment[key] === undefined) environment[key] = value;
        }
        return;
      }
      try { loadEnvFile(file); }
      catch (error) {
        if (error.syscall === 'open') return { kind: 'open', errno: error.errno, path: error.path };
        if (error.code === 'ERR_INVALID_ARG_TYPE') return { kind: 'read', path: `${file}` };
        throw error;
      }
    },
  };
  return { util: factories.publicUtil({ values, util, native }),
    ...factories.dotenv({ values, uv, utils, native }), calls,
    boundary: helper ? 'compiled portable parser/file + controlled native environment' : 'native Node parser/file/environment' };
};
