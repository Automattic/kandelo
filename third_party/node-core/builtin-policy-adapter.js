// Public exposure is separate from loading. Metadata must not evaluate a
// lazy builtin, emit its warning or replace its exports on repeated imports.
function _createNodeBuiltinPolicy(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayFrom, ArrayPrototypeFilter, ArrayPrototypeMap,
        ArrayPrototypePushApply, Error, SafeMap, SafeSet,
        StringPrototypeSlice, StringPrototypeStartsWith } = primordials;
    const builtinIds = platform.ids;
    const selfId = 'internal/bootstrap/realm';
    const { validateString } = platform.values.validators;
    const require = platform.load;
    /* NODE_BUILTIN_POLICY */
    /* NODE_GET_BUILTIN_MODULE */
    BuiltinModule.allowOptionGatedBuiltins(platform.getOptionValue);
    return {
        normalizeRequirableId: BuiltinModule.normalizeRequirableId,
        canBeRequiredWithoutScheme: BuiltinModule.canBeRequiredWithoutScheme,
        isBuiltin: BuiltinModule.isBuiltin,
        getAllBuiltinModuleIds: BuiltinModule.getAllBuiltinModuleIds,
        getBuiltinModule,
    };
}
