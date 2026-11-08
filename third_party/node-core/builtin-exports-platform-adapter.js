// Actual loaded builtin records share public require/process/ESM identity.
function _createNodeBuiltinExports(platform) {
    'use strict';
    const { ArrayPrototypeSlice, ArrayPrototypeIncludes, ArrayPrototypePush,
        ObjectKeys, ObjectPrototypeHasOwnProperty, ReflectGet,
        SafeMap, StringPrototypeStartsWith, Error } = _createNodePrimordials();
    const Module = platform.Module;
    /* NODE_BUILTIN_EXPORT_GET_OWN */
    class BuiltinModule {
        static map = new SafeMap();
        static canBeRequiredByUsers(id) { return platform.canBeRequiredByUsers(id); }
        static canBeRequiredWithoutScheme(id) { return platform.canBeRequiredWithoutScheme(id); }
        constructor(id) {
            this.id = id;
            this.loaded = false;
            this.exports = undefined;
            this.exportKeys = undefined;
            // This is only an actual native synthetic module owner supplied
            // after its real environment exists, never a URL/name lookup.
            this.module = undefined;
        }
        compileForInternalLoader() {
            if (!this.loaded) {
                this.exports = platform.load(this.id);
                this.loaded = true;
            }
            return this.exports;
        }
        /* NODE_BUILTIN_EXPORT_PUBLIC_LOAD */
        /* NODE_BUILTIN_EXPORT_SYNC */
    }
    for (const id of platform.ids) BuiltinModule.map.set(id, new BuiltinModule(id));
    /* NODE_BUILTIN_EXPORT_PUBLIC_SYNC */
    function load(id) {
        const builtin = BuiltinModule.map.get(id);
        if (builtin === undefined) throw new Error('Unknown actual builtin record: ' + id);
        return builtin.compileForPublicLoader();
    }
    function descriptor(id) {
        load(id);
        const builtin = BuiltinModule.map.get(id);
        const names = ArrayPrototypeSlice(builtin.exportKeys);
        if (!ArrayPrototypeIncludes(names, 'default')) ArrayPrototypePush(names, 'default');
        return { __proto__: null, format: 'synthetic', exportNames: names,
            initialize(owner) { builtin.module = owner; },
            evaluate(owner) {
                builtin.syncExports();
                owner.setExport('default', builtin.exports);
                // Returning the exact actual owner tells the native evaluator
                // that bindings were written in sequence through its setter.
                return owner;
            } };
    }
    // process.getBuiltinModule uses internal require in the pinned helper:
    // it must not snapshot public export keys until actual public loading.
    function loadInternal(id) {
        const builtin = BuiltinModule.map.get(id);
        if (builtin === undefined) throw new Error('Unknown actual builtin record: ' + id);
        return builtin.compileForInternalLoader();
    }
    return { load, loadInternal, descriptor };
}
