// Pinned Undici Request and Body algorithms share actual stream, header-list,
// FormData, Blob/File and abort owners. HTTP transport remains its own owner.
function _createNodeFetchBodyPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { SafeMap, ObjectPrototypeHasOwnProperty, Error } = primordials;
    const { Buffer, Blob, File, URL, URLSearchParams, AbortController, TextEncoder, TextDecoder, TextDecoderStream, process } = platform;
    const { ReadableStream, TransformStream } = platform.stream.web;
    const factories = {
        __proto__: null,
        /* NODE_FETCH_BODY_MODULES */
    };
    const modules = new SafeMap();
    function require(name, from) {
        if (name === 'node:assert') return platform.assert;
        if (name === 'node:util') return platform.util;
        if (name === 'node:events') return platform.events;
        if (name === 'node:stream') return platform.stream.api;
        if (name === 'node:stream/web') return platform.stream.web;
        if (name === './headers') return platform.formData.headers;
        if (name === '../../core/symbols') return platform.formData.coreSymbols;
        if (name === 'node:util/types') return platform.types;
        if (name === './formdata') return platform.formData;
        if (name === '../webidl') return { webidl: platform.formData.webidl };
        if (name === '../../core/util') return { ...require('corePrimitive'),
            isDisturbed: platform.stream.api.isDisturbed,
            kEnumerableProperty: platform.values.util.kEnumerableProperty };
        const id = name === './data-url' ? 'dataURL' : name === '../infra' ? 'infra' :
            name === './formdata-parser' ? 'multipart' : name === './util' ? 'util' :
            name === '../../encoding' ? 'encoding' : name === './tree' ? 'tree' :
            name === './constants' ? (from === 'tree' ? 'coreConstants' : 'fetchConstants') :
            name === './global' ? 'globalOrigin' : name === './body' ? 'body' : name;
        if (modules.has(id)) return modules.get(id).exports;
        if (!ObjectPrototypeHasOwnProperty(factories, id)) {
            const error = new Error('Unsupported Fetch Body dependency: ' + name);
            error.code = 'ERR_NOT_IMPLEMENTED'; throw error;
        }
        const module = { exports: {} };
        modules.set(id, module);
        try { factories[id](module, module.exports, name => require(name, id)); }
        catch (error) { modules.delete(id); throw error; }
        return module.exports;
    }
    const body = require('body');
    require('bodyInit');
    return { ...body, ...require('request'),
        isFormData: platform.formData.webidl.is.FormData };
}
