'use strict';
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const os = require('node:os');
const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, 'third_party/node-core/node-core.js'), 'utf8');
const factories = Function(`${source}; return { install: _installNodeProcessLifetime, values: _createNodeValuesPlatform };`)();
// This is a frontend/native-dependency control: real native process events,
// WeakRef, FinalizationRegistry and worker lifecycle, never guest evidence.
const values = factories.values({ process, Buffer, util, inspection: util, os,
  signals: os.constants.signals, getDOMException: () => DOMException });
const previousRef = process.ref;
const previousGetter = Object.getOwnPropertyDescriptor(process, 'finalization').get;
factories.install({ process, values });
if (process.ref === previousRef || Object.getOwnPropertyDescriptor(process, 'finalization').get === previousGetter) {
  throw Error('Candidate process lifetime frontend was not installed');
}
// An out-of-band receipt proves unchanged upstream child/worker fixtures also
// loaded this exact bundle. It adds no process listeners or GC registrations.
if (process.env.KANDELO_PROCESS_LIFETIME_RECEIPTS) {
  const { isMainThread, threadId } = require('node:worker_threads');
  const { createHash } = require('node:crypto');
  fs.appendFileSync(process.env.KANDELO_PROCESS_LIFETIME_RECEIPTS, JSON.stringify({
    pid: process.pid, threadId, isMainThread,
    bundleSha256: createHash('sha256').update(source).digest('hex'),
  }) + '\n');
}
