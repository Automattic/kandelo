'use strict';
const {
    ArrayPrototypePop, ArrayPrototypePush, AsyncIteratorPrototype, Error,
    NumberMAX_SAFE_INTEGER, ObjectSetPrototypeOf, Promise, PromiseReject,
    PromiseResolve, ReflectApply, SymbolAsyncIterator, SymbolDispose, SymbolFor,
} = primordials;
const { AbortError, codes: { ERR_INVALID_ARG_TYPE } } = require('internal/errors');
const { kEmptyObject } = require('internal/util');
const { validateObject, validateAbortSignal, validateInteger } = require('internal/validators');
const { addAbortListener } = require('internal/events/abort_listener');
const EventEmitter = require('events');
const { kMaxEventTargetListeners } = EventEmitter;
const kWatermarkData = SymbolFor('nodejs.watermarkData');
let FixedQueue, kFirstEventParam, kResistStopPropagation;
function _getMaxListeners(that) {
    return that._maxListeners === undefined ? EventEmitter.defaultMaxListeners : that._maxListeners;
}
