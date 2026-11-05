// Use the pinned Buffer number/BigInt algorithms and prototype assignments.
// Encoding, allocation, copying and transfer remain separate owning-layer work.
function _installNodeBufferNumeric(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    function require(name) {
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/validators') return platform.values.validators;
        throw new primordials.Error('Unknown numeric Buffer dependency: ' + name);
    }
    /* NODE_BUFFER_NUMERIC_ALGORITHMS */
    function install(proto) {
        /* NODE_BUFFER_NUMERIC_PROTOTYPE */
    }
    install(platform.Buffer.prototype);
}
