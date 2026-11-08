// Ordinary-process public FIPS state over the actual linked native owner.
// Pinned crypto.js265-280 non-forced branches; forced startup/config/provider
// admission remains unimplemented and is rejected by the current CLI parser.
function _installNodeCryptoFips(api, platform) {
    'use strict';
    const { ObjectDefineProperties } = _createNodePrimordials();
    const { deprecate } = platform.values.util;
    const { ERR_WORKER_UNSUPPORTED_OPERATION } = platform.values.errors.codes;
    const { getFipsCrypto, setFipsCrypto, ownsCryptoProcessState } = platform.native;
    function lazyOwnsProcessState() { return ownsCryptoProcessState(); }
    function getFips() {
        return getFipsCrypto();
    }
    function setFips(val) {
        if (!lazyOwnsProcessState()) {
            throw new ERR_WORKER_UNSUPPORTED_OPERATION('Calling crypto.setFips()');
        }
        setFipsCrypto(val);
    }
    ObjectDefineProperties(api, {
        getFips: { __proto__: null, value: getFips,
            enumerable: true, writable: true, configurable: true },
        setFips: { __proto__: null, value: setFips,
            enumerable: true, writable: true, configurable: true },
        fips: {
            __proto__: null,
            get: deprecate(getFips, 'The crypto.fips is deprecated. ' +
              'Please use crypto.getFips()', 'DEP0093'),
            set: deprecate(setFips, 'The crypto.fips is deprecated. ' +
              'Please use crypto.setFips()', 'DEP0093'),
        },
    });
}
