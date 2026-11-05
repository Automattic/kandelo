'use strict';
// Actual complete public constructor/pool/codec/byte source over exact native
// allocator/alignment/detach-key dependencies. No guest/four-host claim.
exports.create = (...args) => require('./node-buffer-pool.cjs').create(...args);
