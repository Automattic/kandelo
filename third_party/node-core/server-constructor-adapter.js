// Generic public receiver initialization, independent of HTTP or any subclass.
function _createNodeServerConstructor(platform) {
    'use strict';
    const { ObjectDefineProperty, ObjectGetOwnPropertyDescriptor, ObjectSetPrototypeOf } = _createNodePrimordials();
    const EventEmitter = platform.EventEmitter;
    const { ERR_INVALID_ARG_TYPE } = platform.values.errors.codes;
    const { validateNumber } = platform.values.validators;
    const getDefaultHighWaterMark = platform.getDefaultHighWaterMark;
    const kEmptyObject = platform.values.util.kEmptyObject;
    const module = { get exports() { return platform.getExports(); } };
    function Server(options, connectionListener) {
        if (!(this instanceof Server)) return new Server(options, connectionListener);
        EventEmitter.call(this);
        // Existing real clone mode denies cloning/transfer. A transferable
        // listener must wait for its actual Worker/native owner, not a flag.
        platform.markResource(this);
        /* NODE_SERVER_CONSTRUCTOR_OPTIONS */
        platform.initializeOwner(this);
        /* NODE_SERVER_CONSTRUCTOR_FIELDS */
    }
    Server.prototype = platform.prototype;
    ObjectDefineProperty(Server.prototype, 'constructor', { value: Server, writable: true, configurable: true });
    ObjectSetPrototypeOf(Server.prototype, EventEmitter.prototype);
    ObjectSetPrototypeOf(Server, EventEmitter);
    for (const name of ['listen', 'address', 'getConnections', 'close', 'ref', 'unref']) {
        const descriptor = ObjectGetOwnPropertyDescriptor(Server.prototype, name);
        ObjectDefineProperty(Server.prototype, name, { ...descriptor, enumerable: true });
    }
    ObjectDefineProperty(Server.prototype, 'listening', {
        __proto__: null,
        get: function() { return platform.listening(this); },
        configurable: true, enumerable: true,
    });
    return Server;
}
