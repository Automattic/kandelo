let EventEmitterAsyncResource;
// The EventEmitterAsyncResource has to be initialized lazily because event.js
// is loaded so early in the bootstrap process, before async_hooks is available.
//
// This implementation was adapted straight from addaleax's
// eventemitter-asyncresource MIT-licensed userland module.
// https://github.com/addaleax/eventemitter-asyncresource
function lazyEventEmitterAsyncResource() {
  if (EventEmitterAsyncResource === undefined) {
    const {
      AsyncResource,
    } = require('async_hooks');

    class EventEmitterReferencingAsyncResource extends AsyncResource {
      #eventEmitter;

      /**
       * @param {EventEmitter} ee
       * @param {string} [type]
       * @param {{
       *   triggerAsyncId?: number,
       *   requireManualDestroy?: boolean,
       * }} [options]
       */
      constructor(ee, type, options) {
        super(type, options);
        this.#eventEmitter = ee;
      }

      /**
       * @type {EventEmitter}
       */
      get eventEmitter() {
        return this.#eventEmitter;
      }
    }

    EventEmitterAsyncResource =
      class EventEmitterAsyncResource extends EventEmitter {
        #asyncResource;

        /**
         * @param {{
         *   name?: string,
         *   triggerAsyncId?: number,
         *   requireManualDestroy?: boolean,
         * }} [options]
         */
        constructor(options = undefined) {
          let name;
          if (typeof options === 'string') {
            name = options;
            options = undefined;
          } else {
            if (new.target === EventEmitterAsyncResource) {
              validateString(options?.name, 'options.name');
            }
            name = options?.name || new.target.name;
          }
          super(options);

          this.#asyncResource = new EventEmitterReferencingAsyncResource(this, name, options);
        }

        /**
         * @param {symbol|string} event
         * @param {any[]} args
         * @returns {boolean}
         */
        emit(event, ...args) {
          const asyncResource = this.#asyncResource;
          ArrayPrototypeUnshift(args, super.emit, this, event);
          return ReflectApply(asyncResource.runInAsyncScope, asyncResource,
                              args);
        }

        /**
         * @returns {void}
         */
        emitDestroy() {
          this.#asyncResource.emitDestroy();
        }

        /**
         * @type {number}
         */
        get asyncId() {
          return this.#asyncResource.asyncId();
        }

        /**
         * @type {number}
         */
        get triggerAsyncId() {
          return this.#asyncResource.triggerAsyncId();
        }

        /**
         * @type {EventEmitterReferencingAsyncResource}
         */
        get asyncResource() {
          return this.#asyncResource;
        }
      };
  }
  return EventEmitterAsyncResource;
}
