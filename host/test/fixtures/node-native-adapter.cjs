'use strict';
// Execute the complete production prefix in its own realm. Native engine/OS
// operations are supplied explicitly by the caller, never filled by fallbacks.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function createNativeAdapter(native) {
  const prefix = fs.readFileSync(path.resolve(__dirname,
    '../../../packages/registry/spidermonkey/node-compat/adapter.js'), 'utf8');
  const context = vm.createContext({ __kandeloNodeNative: native, TextEncoder,
    TextDecoder, queueMicrotask, scriptArgs: [], scriptPath: '', });
  return vm.runInContext(prefix + '\nreturn _nodeNative;\n})()', context,
    { filename: 'kandelo-native-adapter-control.js' });
}
module.exports = { createNativeAdapter };
