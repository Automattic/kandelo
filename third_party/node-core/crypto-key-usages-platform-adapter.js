// Rights are the actual immutable native CryptoKey mask. Public usages arrays
// are independently cached metadata and cannot grant additional authority.
function _createNodeCryptoKeyUsages() {
    'use strict';
    const { ArrayPrototypeIncludes, ArrayPrototypePush, SafeSet } = _createNodePrimordials();
    /* NODE_KEY_USAGE_MASKS */
    /* NODE_KEY_USAGE_MEMBERSHIP */
    return { hasAnyNotIn, getUsagesMask, getUsagesFromMask, hasUsage, toUsagesSet };
}
