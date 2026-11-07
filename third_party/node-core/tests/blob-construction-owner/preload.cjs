const fs = require('fs');
const source = fs.readFileSync(process.env.KANDELO_BLOB_SOURCE, 'utf8');
const start = source.indexOf('const _nodeBodyData = (() => {');
const end = source.indexOf("\nif (typeof globalThis.Blob === 'undefined')", start);
if (start < 0 || end < 0) throw new Error('Actual Blob owner selection missing');
const factory = new Function('_nodeClonePlatform', '_nodeValues', '_nodeEventPlatform', '_nodeBufferConstants', '_nodeWebPlatform',
  source.slice(start, end) + '\nreturn _nodeBodyData;');
const owner = factory({ protocol: require('internal/worker/js_transferable') }, {
  validators: require('internal/validators'), errors: require('internal/errors'), util: require('internal/util'), require,
}, { require }, require('buffer').constants, { streams: require('stream/web') });
require('buffer').Blob = owner.Blob;
