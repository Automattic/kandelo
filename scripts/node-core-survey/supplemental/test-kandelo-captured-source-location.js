// Flags: --expose-internals
'use strict';

const common = require('../common');
const assert = require('node:assert/strict');
const { internalBinding } = require('internal/test/binding');
const { getErrorSourcePositions } = internalBinding('errors');

common.expectWarning('internal/test/binding', 'These APIs are for internal testing only. Do not use them.');

function capture() {
  const target = {};
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 1;
  try {
    Error.captureStackTrace(target, capture);
  } finally {
    Error.stackTraceLimit = limit;
  }
  return target;
}

const captured = capture();
const formatted = capture();
assert.equal(typeof formatted.stack, 'string');
const assigned = capture();
assigned.stack = 'user-provided stack';
const deleted = capture();
delete deleted.stack;

const previousPrepare = Error.prepareStackTrace;
Error.prepareStackTrace = common.mustNotCall('structured source locations must not format the stack');
try {
  const observed = getErrorSourcePositions(captured);
  assert.equal(observed.sourceLine, 'const captured = capture();');
  assert.equal(observed.scriptResourceName, __filename);
  assert.equal(observed.startColumn, observed.sourceLine.indexOf('capture()'));
  const formattedPosition = getErrorSourcePositions(formatted);
  const assignedPosition = getErrorSourcePositions(assigned);
  const deletedPosition = getErrorSourcePositions(deleted);
  assert.equal(formattedPosition.sourceLine.trim(), 'const formattedPosition = getErrorSourcePositions(formatted);');
  assert.equal(assignedPosition.sourceLine.trim(), 'const assignedPosition = getErrorSourcePositions(assigned);');
  assert.equal(deletedPosition.sourceLine, 'const deleted = capture();');
} finally {
  Error.prepareStackTrace = previousPrepare;
}
