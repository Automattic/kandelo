// Real synchronous import-goal resolution/cache/hooks. Source execution and
// asynchronous loader workers remain separate owners, not supplied by this API.
function _createNodeModuleSyncResolver(platform) {
    'use strict';
    const { ArrayPrototypeJoin, ArrayPrototypeMap, ArrayPrototypeSort, JSONStringify,
        ObjectKeys, SafeMap } = _createNodePrimordials();
    const { kEmptyObject } = platform.values.util;
    const { getDefaultConditions } = platform.policy;
    const { defaultResolve } = platform.policy.resolver;
    const { resolveHooks: syncResolveHooks, resolveWithHooks: resolveWithSyncHooks,
        loadHooks: syncLoadHooks, loadWithHooks: loadWithSyncHooks, validateLoadSloppy } = platform.hooks;
    const { defaultLoadSync, throwUnknownModuleFormat } = platform.load;
    /* NODE_MODULE_RESOLVE_CACHE */
    class ModuleSyncResolver {
        #defaultConditions = getDefaultConditions();
        #resolveCache = new ResolveCache();
        // module.register() remains unavailable, so no async worker is created
        // or impersonated. The unchanged synchronous algorithms still own all
        // real default/cache/customization-hook resolution below.
        #asyncLoaderHooks;
        /* NODE_MODULE_CACHED_RESOLVE */
        /* NODE_MODULE_RESOLVE_DEFAULT */
        /* NODE_MODULE_RESOLVE_SYNC */
        /* NODE_MODULE_LOAD_PUBLIC */
        /* NODE_MODULE_LOAD_STEP */
        /* NODE_MODULE_LOAD_SYNC */
        /* NODE_MODULE_LOAD_VALIDATE */
    }
    return new ModuleSyncResolver();
}
