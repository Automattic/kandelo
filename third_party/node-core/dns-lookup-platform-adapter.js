// Unchanged pinned public lookup algorithms over actual native request owners.
// Resolver/record APIs have a distinct c-ares owner and are not fabricated here.
function _createNodeDnsLookupPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ObjectDefineProperty, ObjectSetPrototypeOf, Symbol, TypeError,
        ReflectApply, StringPrototypeIndexOf, StringPrototypeSlice } = primordials;
    const { DNSException, codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE,
        ERR_MISSING_ARGS, ERR_METHOD_NOT_IMPLEMENTED } } = platform.values.errors;
    const { validateBoolean, validateFunction, validateNumber, validateOneOf,
        validatePort, validateString, validateStringWithoutNullBytes } = platform.values.validators;
    const { customPromisifyArgs } = platform.values.util;
    const process = platform.process;
    const { isIP } = platform.ip;
    const { hasObserver, startPerf, stopPerf } = platform.observation;
    const native = platform.native;
    const getResourceInfo = native.getAsyncResourceInfo;
    const providerIds = platform.asyncProviders;
    function AsyncWrap() { throw new TypeError('Illegal constructor'); }
    ObjectDefineProperty(AsyncWrap.prototype, 'getAsyncId', {
        value: function getAsyncId() { return ReflectApply(getResourceInfo, native, [this])[0]; },
        writable: true, configurable: true, enumerable: true,
    });
    ObjectDefineProperty(AsyncWrap.prototype, 'getAsyncContextFrameForDebuggingOnly', {
        value: function getAsyncContextFrameForDebuggingOnly() { return ReflectApply(getResourceInfo, native, [this])[2]; },
        writable: true, configurable: true, enumerable: true,
    });
    ObjectDefineProperty(AsyncWrap.prototype, 'getProviderType', {
        value: function getProviderType() { return providerIds[ReflectApply(getResourceInfo, native, [this])[3]] ?? 0; },
        writable: true, configurable: true, enumerable: true,
    });
    ObjectDefineProperty(AsyncWrap.prototype, 'asyncReset', {
        value: function asyncReset() { throw new ERR_METHOD_NOT_IMPLEMENTED('DNS request asyncReset'); },
        writable: true, configurable: true, enumerable: true,
    });
    function createRequest(target, fallback, name) {
        if (target === undefined) throw new TypeError('DNS request requires new');
        const prototype = target.prototype;
        return native.createDnsRequest(prototype !== null &&
            (typeof prototype === 'object' || typeof prototype === 'function') ? prototype : fallback, name);
    }
    function GetAddrInfoReqWrap() { return createRequest(new.target, GetAddrInfoReqWrap.prototype, false); }
    function GetNameInfoReqWrap() { return createRequest(new.target, GetNameInfoReqWrap.prototype, true); }
    ObjectSetPrototypeOf(GetAddrInfoReqWrap.prototype, AsyncWrap.prototype);
    ObjectSetPrototypeOf(GetNameInfoReqWrap.prototype, AsyncWrap.prototype);
    const flags = native.dnsLookupConstants();
    const BufferByteLength = platform.Buffer.byteLength;
    const hostnameToASCII = platform.hostnameToASCII;
    const cares = {
        ...flags, GetAddrInfoReqWrap, GetNameInfoReqWrap,
        DNS_ORDER_VERBATIM: 0, DNS_ORDER_IPV4_FIRST: 1, DNS_ORDER_IPV6_FIRST: 2,
        getaddrinfo(req, hostname, family, hints, order) {
            // Raw UTS46, not a URL-host setter: DNS must not interpret a port,
            // path, credentials, percent escape or numeric host as URL syntax.
            const ascii = BufferByteLength(hostname, 'utf8') > 16384 ? '' :
                hostnameToASCII(hostname, { checkHyphens: false, checkBidi: true,
                    checkJoiners: true, useSTD3ASCIIRules: false,
                    transitionalProcessing: false, verifyDNSLength: false,
                    ignoreInvalidPunycode: false }) ?? '';
            return native.dnsLookup(req, ascii, family, hints, order);
        },
        getnameinfo(req, address, port) { return native.dnsLookupService(req, address, port); },
    };
    function QueryReqWrap() { return createRequest(new.target, QueryReqWrap.prototype, undefined); }
    ObjectSetPrototypeOf(QueryReqWrap.prototype, AsyncWrap.prototype);
    function ChannelWrap(timeout, tries, maxTimeout) {
        if (new.target === undefined) throw new TypeError('DNS channel requires new');
        const prototype = new.target.prototype;
        return native.createDnsChannel(prototype !== null &&
            (typeof prototype === 'object' || typeof prototype === 'function') ? prototype : ChannelWrap.prototype,
            timeout, tries, maxTimeout);
    }
    ObjectSetPrototypeOf(ChannelWrap.prototype, AsyncWrap.prototype);
    const recordTypes = { queryAny: 255, queryA: 1, queryAaaa: 28,
        queryCaa: 257, queryCname: 5, queryMx: 15, queryNs: 2,
        queryTlsa: 52, queryTxt: 16, querySrv: 33, queryPtr: 12,
        queryNaptr: 35, querySoa: 6, getHostByAddr: 0 };
    for (const name of primordials.ObjectKeys(recordTypes)) {
        ObjectDefineProperty(ChannelWrap.prototype, name, {
            value: function(req, hostname) {
                const ascii = hostnameToASCII(hostname, { checkHyphens: false, checkBidi: true,
                    checkJoiners: true, useSTD3ASCIIRules: false,
                    transitionalProcessing: false, verifyDNSLength: false,
                    ignoreInvalidPunycode: false }) ?? '';
                return native.dnsQuery(this, req, ascii, recordTypes[name]);
            }, writable: true, configurable: true, enumerable: true,
        });
    }
    function localAddressFamily(text) {
        // Public setLocalAddress validates a string, then uv_inet_pton accepts
        // any IPv6 zone suffix. isIP alone has a stricter zone grammar.
        const zone = StringPrototypeIndexOf(text, '%');
        if (zone !== -1)
            return isIP(StringPrototypeSlice(text, 0, zone)) === 6 ? 6 : 0;
        return isIP(text);
    }
    const methods = {
        getServers() { return native.dnsGetServers(this); },
        setServers(servers) { return native.dnsSetServers(this, servers); },
        cancel() { native.dnsCancel(this); },
        setLocalAddress(first, second) {
            function invalid(message) {
                const error = new primordials.TypeError(message);
                error.code = 'ERR_INVALID_ARG_VALUE'; throw error;
            }
            const firstFamily = localAddressFamily(first);
            if (!firstFamily) invalid('Invalid IP address.');
            native.dnsSetLocalIP(this, firstFamily, first);
            if (second !== undefined) {
                const secondFamily = localAddressFamily(second);
                if (!secondFamily) invalid('Invalid IP address.');
                if (firstFamily === secondFamily)
                    invalid(firstFamily === 4 ? 'Cannot specify two IPv4 addresses.' : 'Cannot specify two IPv6 addresses.');
                native.dnsSetLocalIP(this, secondFamily, second);
            } else native.dnsSetLocalIP(this, firstFamily === 4 ? 6 : 4, firstFamily === 4 ? '::' : '0.0.0.0');
        },
    };
    for (const name of primordials.ObjectKeys(methods))
        ObjectDefineProperty(ChannelWrap.prototype, name, { value: methods[name],
            writable: true, configurable: true, enumerable: true });
    cares.ChannelWrap = ChannelWrap;
    cares.QueryReqWrap = QueryReqWrap;
    cares.strerror = code => native.dnsStrError(code);
    const { ObjectGetOwnPropertyDescriptor, SymbolPrototypeGetDescription } = primordials;
    const kEmptyObject = platform.values.require('internal/util').kEmptyObject;
    const assert = platform.values.require('internal/assert');
    /* NODE_DNS_ASSIGN_FUNCTION_NAME */
    const modules = new primordials.SafeMap();
    const factories = {
        /* NODE_DNS_MODULES */
    };
    function require(name) {
        if (modules.has(name)) return modules.get(name).exports;
        if (factories[name] !== undefined) {
            const module = { exports: {} };
            modules.set(name, module);
            try { factories[name](module, require, internalBinding, primordials, process); }
            catch (error) { modules.delete(name); throw error; }
            return module.exports;
        }
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/net') return platform.ip;
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/util') return { customPromisifyArgs, assignFunctionName };
        if (name === 'internal/perf/observe') return platform.observation;
        if (name === 'internal/options') return { getOptionValue: () => native.cliOptions?.dnsResultOrder };
        if (name === 'internal/v8/startup_snapshot') return { namespace: {
            isBuildingSnapshot: () => false,
            addSerializeCallback() { throw new ERR_METHOD_NOT_IMPLEMENTED('DNS startup snapshot'); },
            addDeserializeCallback() { throw new ERR_METHOD_NOT_IMPLEMENTED('DNS startup snapshot'); },
        } };
        throw new ERR_METHOD_NOT_IMPLEMENTED(name);
    }
    function internalBinding(name) {
        if (name === 'cares_wrap') return cares;
        throw new ERR_METHOD_NOT_IMPLEMENTED(name);
    }
    require('internal/dns/utils').initializeDns();
    const api = require('dns');
    return { api, get promises() { return api.promises; } };
}
