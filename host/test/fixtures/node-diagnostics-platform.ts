import { readFileSync } from 'node:fs';
import { constants } from 'node:os';
import * as util from 'node:util';

const bundle = readFileSync(new URL('../../../third_party/node-core/node-core.js', import.meta.url), 'utf8');
const factories = Function(`${bundle};return { diagnostics: _createNodeDiagnosticsPlatform, values: _createNodeValuesPlatform };`)();

// Real shared guest algorithms with native engine brands and callback scheduling
// as explicit test boundaries. This does not supply guest async/fatal policy.
export function createDiagnosticsPlatform() {
  const boundary = { platform: 'kandelo', nextTick: process.nextTick.bind(process),
    emitWarning: process.emitWarning.bind(process) };
  const values = factories.values({ process: boundary, Buffer, util, inspection: util,
    os: {}, signals: constants.signals, getDOMException: () => DOMException });
  return { ...factories.diagnostics({ process: boundary, values, types: util.types }), values };
}
