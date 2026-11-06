// Pinned Undici Body consumers over the existing actual stream, header-list,
// FormData and File owners. Extraction/transport remain separate consumers.
function _createNodeFetchBodyPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { SafeMap, ObjectPrototypeHasOwnProperty, Error } = primordials;
    const { Buffer, Blob, File, URLSearchParams, TextEncoder, TextDecoder, TextDecoderStream } = platform;
    const { ReadableStream } = platform.stream.web;
    const factories = {
        __proto__: null,
        /* NODE_FETCH_BODY_MODULES */
    };
    const modules = new SafeMap();
    function require(name) {
        if (name === 'node:assert') return platform.assert;
        if (name === 'node:util/types') return platform.types;
        if (name === './formdata') return platform.formData;
        if (name === '../webidl') return { webidl: platform.formData.webidl };
        if (name === '../../core/util') return {
            isDisturbed: platform.stream.api.isDisturbed,
            bufferToLowerCasedHeaderName: require('corePrimitive').bufferToLowerCasedHeaderName,
        };
        const id = name === './data-url' ? 'dataURL' : name === '../infra' ? 'infra' :
            name === './formdata-parser' ? 'multipart' : name === './util' ? 'util' :
            name === '../../encoding' ? 'encoding' : name === './tree' ? 'tree' :
            name === './constants' ? 'coreConstants' : name;
        if (modules.has(id)) return modules.get(id).exports;
        if (!ObjectPrototypeHasOwnProperty(factories, id)) {
            const error = new Error('Unsupported Fetch Body dependency: ' + name);
            error.code = 'ERR_NOT_IMPLEMENTED'; throw error;
        }
        const module = { exports: {} };
        modules.set(id, module);
        try { factories[id](module, module.exports, require); }
        catch (error) { modules.delete(id); throw error; }
        return module.exports;
    }
    return { mixinBody: require('body').mixinBody };
}
