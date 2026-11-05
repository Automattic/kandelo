'use strict';
// Only the three public marking frontends are replaced. Native Node owns the
// actual private marks, serializers, ports, Blob/Response and event loop here.
// This is not guest registry/GC/transport or four-host conformance.
const wt = require('node:worker_threads');
const { io, marks } = require('./node-ports-platform.cjs');
wt.markAsUncloneable = io.markAsUncloneable;
wt.markAsUntransferable = marks.markAsUntransferable;
wt.isMarkedAsUntransferable = marks.isMarkedAsUntransferable;
