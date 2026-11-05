function getEventListeners(emitterOrTarget, type) {
  // First check if EventEmitter
  if (typeof emitterOrTarget.listeners === 'function') {
    return emitterOrTarget.listeners(type);
  }
  // Require event target lazily to avoid always loading it
  const { isEventTarget, kEvents } = require('internal/event_target');
  if (isEventTarget(emitterOrTarget)) {
    const root = emitterOrTarget[kEvents]?.get(type);
    const listeners = [];
    let handler = root?.next;
    while (handler?.listener !== undefined) {
      const listener = handler.listener?.deref ?
        handler.listener.deref() : handler.listener;
      listeners.push(listener);
      handler = handler.next;
    }
    return listeners;
  }
  throw new ERR_INVALID_ARG_TYPE('emitter',
                                 ['EventEmitter', 'EventTarget'],
                                 emitterOrTarget);
}

/**
 * Returns the max listeners set.
 * @param {EventEmitter | EventTarget} emitterOrTarget
 * @returns {number}
 */
function getMaxListeners(emitterOrTarget) {
  if (typeof emitterOrTarget?.getMaxListeners === 'function') {
    return _getMaxListeners(emitterOrTarget);
  } else if (typeof emitterOrTarget?.[kMaxEventTargetListeners] === 'number') {
    return emitterOrTarget[kMaxEventTargetListeners];
  }

  throw new ERR_INVALID_ARG_TYPE('emitter',
                                 ['EventEmitter', 'EventTarget'],
                                 emitterOrTarget);
}

/**
 * Returns the number of registered listeners for `type`.
 * @param {EventEmitter | EventTarget} emitterOrTarget
 * @param {string | symbol} type
 * @returns {number}
 */
function listenerCount(emitterOrTarget, type) {
  if (typeof emitterOrTarget.listenerCount === 'function') {
    return emitterOrTarget.listenerCount(type);
  }
  const { isEventTarget, kEvents } = require('internal/event_target');
  if (isEventTarget(emitterOrTarget)) {
    return emitterOrTarget[kEvents]?.get(type)?.size ?? 0;
  }
  throw new ERR_INVALID_ARG_TYPE('emitter',
                                 ['EventEmitter', 'EventTarget'],
                                 emitterOrTarget);
}

/**
 * Creates a `Promise` that is fulfilled when the emitter
 * emits the given event.
 * @param {EventEmitter} emitter
 * @param {string | symbol} name
 * @param {{ signal: AbortSignal; }} [options]
 * @returns {Promise}
 */
async function once(emitter, name, options = kEmptyObject) {
  validateObject(options, 'options');
  const { signal } = options;
  validateAbortSignal(signal, 'options.signal');
  if (signal?.aborted)
    throw new AbortError(undefined, { cause: signal.reason });
  return new Promise((resolve, reject) => {
    const errorListener = (err) => {
      emitter.removeListener(name, resolver);
      if (signal != null) {
        eventTargetAgnosticRemoveListener(signal, 'abort', abortListener);
      }
      reject(err);
    };
    const resolver = (...args) => {
      if (typeof emitter.removeListener === 'function') {
        emitter.removeListener('error', errorListener);
      }
      if (signal != null) {
        eventTargetAgnosticRemoveListener(signal, 'abort', abortListener);
      }
      resolve(args);
    };

    kResistStopPropagation ??= require('internal/event_target').kResistStopPropagation;
    const opts = { __proto__: null, once: true, [kResistStopPropagation]: true };
    eventTargetAgnosticAddListener(emitter, name, resolver, opts);
    if (name !== 'error' && typeof emitter.once === 'function') {
      // EventTarget does not have `error` event semantics like Node
      // EventEmitters, we listen to `error` events only on EventEmitters.
      emitter.once('error', errorListener);
    }
    function abortListener() {
      eventTargetAgnosticRemoveListener(emitter, name, resolver);
      eventTargetAgnosticRemoveListener(emitter, 'error', errorListener);
      reject(new AbortError(undefined, { cause: signal?.reason }));
    }
    if (signal != null) {
      eventTargetAgnosticAddListener(
        signal, 'abort', abortListener, { __proto__: null, once: true, [kResistStopPropagation]: true });
    }
  });
}

function createIterResult(value, done) {
  return { done, value };
}

function eventTargetAgnosticRemoveListener(emitter, name, listener, flags) {
  if (typeof emitter.removeListener === 'function') {
    emitter.removeListener(name, listener);
  } else if (typeof emitter.removeEventListener === 'function') {
    emitter.removeEventListener(name, listener, flags);
  } else {
    throw new ERR_INVALID_ARG_TYPE('emitter', 'EventEmitter', emitter);
  }
}

function eventTargetAgnosticAddListener(emitter, name, listener, flags) {
  if (typeof emitter.on === 'function') {
    if (flags?.once) {
      emitter.once(name, listener);
    } else {
      emitter.on(name, listener);
    }
  } else if (typeof emitter.addEventListener === 'function') {
    emitter.addEventListener(name, listener, flags);
  } else {
    throw new ERR_INVALID_ARG_TYPE('emitter', 'EventEmitter', emitter);
  }
}

/**
 * Returns an `AsyncIterator` that iterates `event` events.
 * @param {EventEmitter} emitter
 * @param {string | symbol} event
 * @param {{
 *    signal: AbortSignal;
 *    close?: string[];
 *    highWaterMark?: number,
 *    lowWaterMark?: number
 *   }} [options]
 * @returns {AsyncIterator}
 */
function on(emitter, event, options = kEmptyObject) {
  // Parameters validation
  validateObject(options, 'options');
  const signal = options.signal;
  validateAbortSignal(signal, 'options.signal');
  if (signal?.aborted)
    throw new AbortError(undefined, { cause: signal.reason });
  // Support both highWaterMark and highWatermark for backward compatibility
  const highWatermark = options.highWaterMark ?? options.highWatermark ?? NumberMAX_SAFE_INTEGER;
  validateInteger(highWatermark, 'options.highWaterMark', 1);
  // Support both lowWaterMark and lowWatermark for backward compatibility
  const lowWatermark = options.lowWaterMark ?? options.lowWatermark ?? 1;
  validateInteger(lowWatermark, 'options.lowWaterMark', 1);

  // Preparing controlling queues and variables
  FixedQueue ??= require('internal/fixed_queue');
  const unconsumedEvents = new FixedQueue();
  const unconsumedPromises = new FixedQueue();
  let paused = false;
  let error = null;
  let finished = false;
  let size = 0;

  const iterator = ObjectSetPrototypeOf({
    next() {
      // First, we consume all unread events
      if (size) {
        const value = unconsumedEvents.shift();
        size--;
        if (paused && size < lowWatermark) {
          emitter.resume(); // Can not be finished yet
          paused = false;
        }
        return PromiseResolve(createIterResult(value, false));
      }

      // Then we error, if an error happened
      // This happens one time if at all, because after 'error'
      // we stop listening
      if (error) {
        const p = PromiseReject(error);
        // Only the first element errors
        error = null;
        return p;
      }

      // If the iterator is finished, resolve to done
      if (finished) return closeHandler();

      // Wait until an event happens
      return new Promise(function(resolve, reject) {
        unconsumedPromises.push({ resolve, reject });
      });
    },

    return() {
      return closeHandler();
    },

    throw(err) {
      if (!err || !(err instanceof Error)) {
        throw new ERR_INVALID_ARG_TYPE('EventEmitter.AsyncIterator',
                                       'Error', err);
      }
      errorHandler(err);
    },
    [SymbolAsyncIterator]() {
      return this;
    },
    [kWatermarkData]: {
      /**
       * The current queue size
       * @returns {number}
       */
      get size() {
        return size;
      },
      /**
       * The low watermark. The emitter is resumed every time size is lower than it
       * @returns {number}
       */
      get low() {
        return lowWatermark;
      },
      /**
       * The high watermark. The emitter is paused every time size is higher than it
       * @returns {number}
       */
      get high() {
        return highWatermark;
      },
      /**
       * It checks whether the emitter is paused by the watermark controller or not
       * @returns {boolean}
       */
      get isPaused() {
        return paused;
      },
    },
  }, AsyncIteratorPrototype);

  // Adding event handlers
  const { addEventListener, removeAll } = listenersController();
  kFirstEventParam ??= require('internal/events/symbols').kFirstEventParam;
  addEventListener(emitter, event, options[kFirstEventParam] ? eventHandler : function(...args) {
    return eventHandler(args);
  });
  if (event !== 'error' && typeof emitter.on === 'function') {
    addEventListener(emitter, 'error', errorHandler);
  }
  const closeEvents = options?.close;
  if (closeEvents?.length) {
    for (let i = 0; i < closeEvents.length; i++) {
      addEventListener(emitter, closeEvents[i], closeHandler);
    }
  }

  const abortListenerDisposable = signal ? addAbortListener(signal, abortListener) : null;

  return iterator;

  function abortListener() {
    errorHandler(new AbortError(undefined, { cause: signal?.reason }));
  }

  function eventHandler(value) {
    if (unconsumedPromises.isEmpty()) {
      size++;
      if (!paused && size > highWatermark) {
        paused = true;
        emitter.pause();
      }
      unconsumedEvents.push(value);
    } else unconsumedPromises.shift().resolve(createIterResult(value, false));
  }

  function errorHandler(err) {
    if (unconsumedPromises.isEmpty()) error = err;
    else unconsumedPromises.shift().reject(err);

    closeHandler();
  }

  function closeHandler() {
    abortListenerDisposable?.[SymbolDispose]();
    removeAll();
    finished = true;
    paused = false;
    const doneResult = createIterResult(undefined, true);
    while (!unconsumedPromises.isEmpty()) {
      unconsumedPromises.shift().resolve(doneResult);
    }

    return PromiseResolve(doneResult);
  }
}

function listenersController() {
  const listeners = [];

  return {
    addEventListener(emitter, event, handler, flags) {
      eventTargetAgnosticAddListener(emitter, event, handler, flags);
      ArrayPrototypePush(listeners, [emitter, event, handler, flags]);
    },
    removeAll() {
      while (listeners.length > 0) {
        ReflectApply(eventTargetAgnosticRemoveListener, undefined, ArrayPrototypePop(listeners));
      }
    },
  };
}
