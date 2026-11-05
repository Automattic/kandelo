'use strict';
// Candidate warning/error/Console owners. Native Node supplies the process
// emitter, scheduler, streams, filesystem, parsed options and stack recapture.
const fs = require('node:fs'), path = require('node:path'), util = require('node:util'), os = require('node:os');
const source = fs.readFileSync(path.resolve(__dirname, '../../../third_party/node-core/node-core.js'), 'utf8');
const factories = Function(source + `;return {values:_createNodeValuesPlatform,warning:_createNodeWarningPlatform,
 console:_createNodeConsolePlatform,diagnostics:_createNodeDiagnosticsPlatform,
 noCapture:Function('_createNodePrimordials','return '+_createNodeWarningPlatform.toString())(
 ()=>{const descriptors=Object.getOwnPropertyDescriptors(_createNodePrimordials());
 descriptors.ErrorCaptureStackTrace={value:undefined};return Object.create(null,descriptors);})};`)();
exports.install = function install(noCapture = false) {
  const get = require('internal/options').getOptionValue;
  const cliOptions = { noWarnings: !get('--warnings'), noDeprecation: get('--no-deprecation'),
    throwDeprecation: get('--throw-deprecation'), traceDeprecation: get('--trace-deprecation'),
    traceWarnings: get('--trace-warnings'), redirectWarnings: get('--redirect-warnings'),
    diagnosticDir: get('--diagnostic-dir'), disableWarnings: get('--disable-warning') };
  let warning;
  const values = factories.values({process,Buffer,util,inspection:util,os,signals:os.constants.signals,
    getWarnings:()=>warning,getDOMException:()=>DOMException});
  const diagnostics = factories.diagnostics({process,values,types:util.types});
  const consoleOwner = factories.console({process,values,inspection:require('internal/util/inspect'),Buffer,
    types:util.types,diagnostics,readline:{callbacks:require('node:readline')},
    monotonicNanoseconds:process.hrtime.bigint.bind(process.hrtime)});
  // Warning output is text. Console.table's previewEntries dependency is not
  // used by these controls and is deliberately not supplied or simulated.
  warning = (noCapture ? factories.noCapture : factories.warning)({process,values,fs,path,cliOptions,getConsole:()=>consoleOwner.api});
  // Native startup already installed its own printer. This control replaces
  // that owner explicitly; a guest process has no outer native warning owner.
  process.removeAllListeners('warning');
  warning.install();
  return { ...warning, values };
};
