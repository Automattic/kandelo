// Public wrappers must remain distinct from the shared internal helpers:
// util.deprecate's fourth argument is options, not synchronous warning mode.
function _createNodePublicUtil(platform) {
    'use strict';
    const { ArrayIsArray, ObjectKeys, ObjectCreate, ObjectFreeze, NumberIsSafeInteger } = _createNodePrimordials();
    const kEmptyObject = ObjectFreeze(ObjectCreate(null));
    const internalDeprecate = platform.values.util.deprecate;
    const { ERR_INVALID_ARG_TYPE, ERR_OUT_OF_RANGE } = platform.values.errors.codes;
    const { validateNumber, validateString } = platform.values.validators;
    const internalErrorName = platform.values.util.getSystemErrorName;
    const internalErrorMessage = platform.values.util.getSystemErrorMessage;
    const types = platform.util.types;
    const binding = platform.native;
    /* NODE_PUBLIC_UTIL_FUNCTIONS */
    return {
        ...platform.values.require('internal/mime'),
        deprecate,
        markPromiseAsHandled,
        parseEnv,
        getSystemErrorName,
        getSystemErrorMessage,
        getSystemErrorMap: platform.values.util.getSystemErrorMap,
        convertProcessSignalToExitCode: platform.values.util.convertProcessSignalToExitCode,
        _extend: internalDeprecate(_extend,
            'The `util._extend` API is deprecated. Please use Object.assign() instead.', 'DEP0060'),
        isArray: internalDeprecate(ArrayIsArray,
            'The `util.isArray` API is deprecated. Please use `Array.isArray()` instead.', 'DEP0044'),
    };
}
