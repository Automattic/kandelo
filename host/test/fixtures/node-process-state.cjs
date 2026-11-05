'use strict';
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const os = require('node:os');
const root = path.resolve(__dirname, '../../..');
const bundle = fs.readFileSync(path.join(root, 'third_party/node-core/node-core.js'), 'utf8');
const factories = Function(`${bundle}; return { state: _createNodeProcessState, values: _createNodeValuesPlatform };`)();
// Keep actual native dependency owners even when an unchanged upstream test
// installs the candidate process.env or umask on the surrounding process.
const environment = process.env;
const rawUmask = process.umask.bind(process);
const nativeBoundary = {
  createEnvironmentObject(callbacks, prototype) {
    // A real native interceptor executes the candidate policy callbacks.
    // No JS Proxy or native process.env replacement stands in for that model.
    const helper = process.env.KANDELO_ENVIRONMENT_NATIVE_HELPER ||
      path.join(root, '.context/node26-environment-native/owner.node');
    if (!fs.existsSync(helper)) throw Error('Missing native environment control: run scripts/dev-shell.sh bash tests/nodejs/build-environment-native-control.sh');
    return require(helper).createEnvironmentObject(callbacks, prototype);
  },
  environment(operation, key, value) {
    if (operation === 'get') return environment[key];
    if (operation === 'set') { environment[key] = value; return 0; }
    if (operation === 'unset') { delete environment[key]; return 0; }
    if (operation === 'keys') return Object.keys(environment);
    throw Error('Unexpected environment operation');
  },
  processUmask: rawUmask,
  processParentPid: () => process.ppid,
  // Explicit native26 dependency boundary; no guest library-version claim.
  getCompressionVersions: () => Object.fromEntries(['zlib', 'brotli', 'zstd'].map(name => [name, process.versions[name]])),
  sqlite: operation => {
    if (operation !== 'version') throw Error('Unexpected SQLite operation');
    return process.versions.sqlite;
  },
  dnsVersion: () => process.versions.ares,
  getOpenSSLVersion: () => process.versions.openssl,
};
function createProcessState() {
  const values = factories.values({ process: { platform: 'kandelo', emitWarning() {
    throw Error('Unexpected process state warning');
  } }, Buffer, util, inspection: util, os, signals: os.constants.signals,
  getDOMException: () => DOMException });
  return factories.state({ native: nativeBoundary, getValues: () => values });
}
module.exports = { createProcessState, nativeBoundary, environment, rawUmask };
