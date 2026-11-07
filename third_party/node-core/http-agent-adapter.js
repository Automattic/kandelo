// Genuine pinned HTTP Agent queues, native socket admission and idle guards.
function _createNodeHttpAgent(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayIsArray, Number, NumberIsFinite, NumberParseInt, ObjectKeys, String, Symbol, decodeURIComponent } = primordials;
    const { process, Buffer, URL } = platform;
    const isIPv4 = platform.net.isIPv4;
    const { ERR_HTTP_HEADERS_SENT, ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_PROXY_INVALID_CONFIG, ERR_OUT_OF_RANGE } = platform.values.errors.codes;
    const { validateNumber, validatePort } = platform.values.validators;
    const TIMEOUT_MAX = 2 ** 31 - 1;
    /* NODE_HTTP_AGENT_TIMER_DURATION */
    /* NODE_HTTP_AGENT_LAZY */
    /* NODE_HTTP_AGENT_PROXY */
    const internalHttp = { parseProxyConfigFromEnv, checkShouldUseProxy, getGlobalAgent,
        kProxyConfig: Symbol('kProxyConfig'), kWaitForProxyTunnel: Symbol('kWaitForProxyTunnel') };
    const module = { exports: {} };
    const kError = Symbol('kError');
    const kAuthority = Symbol('kAuthority'), kProxyRewrittenToAbsolute = Symbol('kProxyRewrittenToAbsolute');
    const kOutHeaders = platform.outgoing.kOutHeaders;
    const kProxyConfig = internalHttp.kProxyConfig;
    const debug = platform.values.require('internal/util/debuglog').debuglog('http');
    /* NODE_HTTP_AGENT_REQUEST_PROXY */
    /* NODE_HTTP_AGENT_VALIDATE_HOST */
    function require(name) {
        if (name === 'net') return platform.net;
        if (name === 'events') return platform.events;
        if (name === 'async_hooks') return platform.async.api;
        if (name === 'internal/async_hooks') return platform.async;
        if (name === 'internal/http') return internalHttp;
        if (name === 'internal/util') return { ...platform.values.util, getLazy };
        if (name === 'internal/stream_base_commons') return platform.socketStream;
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/assert') return platform.assert;
        if (name === 'internal/options') return { getOptionValue: platform.getOptionValue };
        if (name === 'tls') return platform.getTLS();
        if (name === 'internal/util/debuglog') return platform.values.require(name);
        throw new primordials.Error('Unsupported HTTP Agent dependency: ' + name);
    }
    function internalBinding(name) {
        if (name === 'stream_wrap') return platform.socketStream.binding;
        throw new primordials.Error('Unsupported HTTP Agent binding: ' + name);
    }
    (function(module, exports, require, internalBinding, primordials, process) {
        /* NODE_HTTP_AGENT_MODULE */
    })(module, module.exports, require, internalBinding, primordials, process);
    function host(options) {
        return validateHost(options.hostname, 'hostname') || validateHost(options.host, 'host') || 'localhost';
    }
    function prepareHeaders(req, options, host, port, defaultPort) {
        const optsWithoutSignal = { __proto__: null, ...options, host, port };
        const method = req.method;
        const setHost = options.setHost !== undefined ? Boolean(options.setHost) : options.setDefaultHeaders !== false;
        req._removedConnection = options.setDefaultHeaders === false;
        req._removedContLen = options.setDefaultHeaders === false;
        req._removedTE = options.setDefaultHeaders === false;
        return primordials.ReflectApply(function() {
            /* NODE_HTTP_AGENT_REQUEST_HEADERS */
        }, req, []);
    }
    function select(req, options) {
        const Agent = module.exports;
        const { ERR_INVALID_ARG_TYPE, ERR_INVALID_PROTOCOL } = platform.values.errors.codes;
        // This selection is the unchanged pinned ClientRequest Agent contract.
        return Reflect.apply(function() {
            /* NODE_HTTP_AGENT_SELECTION */
            /* NODE_HTTP_AGENT_PROTOCOL */
            /* NODE_HTTP_AGENT_PROTOCOL_CHECK */
            this.protocol = protocol;
            return agent;
        }, req, []);
    }
    function keepAlive(req) {
        const NumberIsFinite = primordials.NumberIsFinite;
        return Reflect.apply(function() {
            /* NODE_HTTP_AGENT_KEEP_ALIVE */
        }, req, []);
    }
    function admit(req, optsWithoutSignal) {
        const { once } = platform.values.util;
        const net = platform.net;
        const debug = platform.values.require('internal/util/debuglog').debuglog('http');
        const emitErrorEvent = (request, error) => request._failed(error);
        return Reflect.apply(function() {
            /* NODE_HTTP_AGENT_ADMISSION */
        }, req, []);
    }
    function installRequestPrototype(ClientRequest) {
        for (const name of ['abort', 'destroy', 'setTimeout', 'setNoDelay', 'setSocketKeepAlive'])
            delete ClientRequest.prototype[name];
        const { ConnResetException } = platform.values.errors;
        const finished = platform.stream.finished;
        const ReflectApply = primordials.ReflectApply;
        const emitErrorEvent = (request, error) => request._failed(error);
        function socketErrorListener(error) {
            this._hadError = true;
            const request = this._httpMessage;
            if (request) request._failed(error);
            this.destroy();
        }
        function tickOnSocket(request, socket) {
            socket.removeListener('error', socketErrorListener);
            request._openSocket(socket);
            if (request.timeout !== undefined || request.agent?.options?.timeout) listenSocketTimeout(request);
        }
        /* NODE_HTTP_AGENT_SOCKET_TIMEOUT */
        /* NODE_HTTP_AGENT_ON_SOCKET */
        /* NODE_HTTP_AGENT_SET_SOCKET_METHODS */
        /* NODE_HTTP_AGENT_DESTROY */
        const destroyRequest = ClientRequest.prototype.destroy;
        ClientRequest.prototype.destroy = function destroy(error) {
            if (!(this.writableFinished && this.res?.complete)) this._destroyed = true;
            return primordials.ReflectApply(destroyRequest, this, [error]);
        };
    }
    function decorateNamespace(namespace) {
        const ObjectDefineProperty = primordials.ObjectDefineProperty;
        const module = { exports: namespace }, httpAgent = moduleOwner;
        /* NODE_HTTP_AGENT_GLOBAL_AGENT */
    }
    const moduleOwner = module.exports;
    /* NODE_HTTP_AGENT_FREE */
    return { module: module.exports, select, keepAlive, admit, internalHttp,
        installRequestPrototype, emitFreeNT, kError, decorateNamespace, getTimerDuration, prepareHeaders, host };
}
