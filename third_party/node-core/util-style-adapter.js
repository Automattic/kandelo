// Complete pinned public styling/cache algorithms consume the real guest
// stream predicates, byte/inspection state and color/TTY policy owners.
function _installNodeUtilStyle(platform) {
    'use strict';
    const { ArrayIsArray, ObjectGetOwnPropertyNames, RegExpPrototypeExec,
        SafeMap, StringPrototypeSlice } = _createNodePrimordials();
    const process = platform.process;
    const Buffer = platform.Buffer;
    const inspect = platform.util.inspect;
    const { validateString, validateObject, validateBoolean, validateOneOf } = platform.values.validators;
    const { ERR_OUT_OF_RANGE, ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE } = platform.values.errors.codes;
    const { isReadableStream, isWritableStream, isNodeStream } = platform.streamUtils;
    function require(name) {
        if (name === 'internal/util/colors') return platform.values.require(name);
        throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('util.styleText dependency ' + name);
    }
    /* NODE_UTIL_STYLE_COLORS */
    /* NODE_UTIL_STYLE_ALGORITHMS */
    platform.util.styleText = styleText;
}
