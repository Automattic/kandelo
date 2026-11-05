'use strict';
const tr46 = require('tr46');

// Node's pinned Ada backend (deps/ada/ada.cpp, from_ascii_to_ascii) follows
// WHATWG's non-strict ASCII rule: lowercase ASCII regardless of ToASCII
// validation. The URL state machine still rejects forbidden host code points
// and parses numeric hosts; this is not a fallback after a parser failure.
exports.toASCII = function toASCII(domain, options) {
  if (!options.useSTD3ASCIIRules && /^[\u0000-\u007f]*$/.test(domain)) {
    return domain.toLowerCase();
  }
  return tr46.toASCII(domain, options);
};

// Ada's to_unicode validates decoded A-labels independently and preserves
// each original label on failure. A whole-domain conversion would lose valid
// neighboring labels or expose a rejected/empty decoded spelling.
exports.toUnicode = function toUnicode(hostname) {
  return hostname.split('.').map(label => {
    const converted = tr46.toUnicode(label, { checkHyphens: false,
      checkBidi: true, checkJoiners: true, useSTD3ASCIIRules: false,
      transitionalProcessing: false });
    return converted.error ? label : converted.domain;
  }).join('.');
};
