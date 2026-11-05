'use strict';
// Actual candidate Console/diagnostics factories. Native inspection, streams,
// readline callbacks, previewEntries and clocks are explicit control boundaries.
const fs = require('node:fs'), path = require('node:path'), util = require('node:util');
const { Writable } = require('node:stream');
const source = fs.readFileSync(path.resolve(__dirname, '../../../third_party/node-core/node-core.js'), 'utf8');
const factories = Function(source + `;return {values:_createNodeValuesPlatform,
  diagnostics:_createNodeDiagnosticsPlatform,console:_createNodeConsolePlatform,
  noCapture:Function('_createNodePrimordials','return '+_createNodeConsolePlatform.toString())(
    ()=>{const descriptors=Object.getOwnPropertyDescriptors(_createNodePrimordials());
      descriptors.ErrorCaptureStackTrace={value:undefined};return Object.create(null,descriptors);})};`)();
const nativeClock = process.hrtime.bind(process);
const nativeBigint = process.hrtime.bigint.bind(process.hrtime);
exports.create = function create(options = {}) {
  const inspection = require('internal/util/inspect');
  const descriptors = ['internalBinding', 'primordials'].map(name => [name,Object.getOwnPropertyDescriptor(globalThis,name)]);
  let internalBinding;
  try { ({internalBinding} = require('internal/test/binding')); }
  finally { for(const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis,name,descriptor); else delete globalThis[name];
  }}
  const out = [], err = [], warnings = [];
  function sink(records) { return new Writable({write(chunk,_encoding,done){records.push(chunk.toString());done();}}); }
  const stdout = options.stdout ?? sink(out), stderr = options.stderr ?? sink(err);
  const control = { env: {...process.env}, pid: process.pid, platform: process.platform,
    nextTick: process.nextTick.bind(process), hrtime: options.hrtime ?? nativeClock,
    stdout, stderr, emitWarning(...args){warnings.push(args);} };
  const values = factories.values({process:control,Buffer,util,inspection,os:require('node:os'),
    signals:require('node:os').constants.signals,getDOMException:()=>DOMException});
  const diagnostics = options.diagnostics ?? factories.diagnostics({process:control,values,types:util.types});
  const create = options.noCapture ? factories.noCapture : factories.console;
  const owner = create({process:control,values,inspection,Buffer,types:util.types,diagnostics,
    readline:{callbacks:require('node:readline')},previewEntries:internalBinding('util').previewEntries,
    monotonicNanoseconds:nativeBigint});
  return {...owner,diagnostics,stdout,stderr,out,err,warnings,process:control,
    close(){stdout.destroy();if(stderr!==stdout)stderr.destroy();}};
};
