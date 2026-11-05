// libuv's error data is independent of its event-loop/runtime ABI. Numeric
// constants come from the guest compiler's real errno definitions, not the
// embedding host or a presumed Linux identity.
function _createNodeUvPlatform(platform) {
    'use strict';
    const { Map, MapPrototypeGet, MapPrototypeSet } = _createNodePrimordials();
    const rows = platform.native.getUvErrorData();
    function getErrorMap() {
        const result = new Map();
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            MapPrototypeSet(result, row[0], [row[1], row[2]]);
        }
        return result;
    }
    const messages = getErrorMap();
    const binding = {
        getErrorMap,
        getErrorMessage(number) {
            const entry = MapPrototypeGet(messages, number);
            return entry ? entry[1] : `Unknown system error ${number}`;
        },
    };
    for (let i = 0; i < rows.length; i++) binding['UV_' + rows[i][1]] = rows[i][0];
    let uvBinding;
    const lazyUv = () => binding;
    /* NODE_UV_ERRMAP_HELPER */
    /* NODE_UV_UTIL_HELPERS */
    return { binding, getSystemErrorName, getSystemErrorMap, getSystemErrorMessage };
}
