function isError(e) {
  // An error could be an instance of Error while not being a native error
  // or could be from a different realm and not be instance of Error but still
  // be a native error.
  return isNativeError(e) || FunctionPrototypeSymbolHasInstance(Error, e);
}


const codesWarned = new SafeSet();

let validateString;
let validateOneOf;

function getDeprecationWarningEmitter(
  code, msg, deprecated, useEmitSync,
  shouldEmitWarning = () => true,
) {
  let warned = false;
  return function(arg) {
    if (!warned && shouldEmitWarning(arg)) {
      warned = true;
      if (code === 'ExperimentalWarning') {
        process.emitWarning(msg, code, deprecated);
      } else if (code !== undefined) {
        if (!codesWarned.has(code)) {
          const emitWarning = useEmitSync ?
            require('internal/process/warning').emitWarningSync :
            process.emitWarning;
          emitWarning(msg, 'DeprecationWarning', code, deprecated);
          codesWarned.add(code);
        }
      } else {
        process.emitWarning(msg, 'DeprecationWarning', deprecated);
      }
    }
  };
}


function normalizeEncoding(enc) {
  if (enc == null || enc === 'utf8' || enc === 'utf-8') return 'utf8';
  return slowCases(enc);
}

function slowCases(enc) {
  switch (enc.length) {
    case 4:
      if (enc === 'UTF8') return 'utf8';
      if (enc === 'ucs2' || enc === 'UCS2') return 'utf16le';
      enc = StringPrototypeToLowerCase(enc);
      if (enc === 'utf8') return 'utf8';
      if (enc === 'ucs2') return 'utf16le';
      break;
    case 3:
      if (enc === 'hex' || enc === 'HEX' ||
      StringPrototypeToLowerCase(enc) === 'hex')
        return 'hex';
      break;
    case 5:
      if (enc === 'ascii') return 'ascii';
      if (enc === 'ucs-2') return 'utf16le';
      if (enc === 'UTF-8') return 'utf8';
      if (enc === 'ASCII') return 'ascii';
      if (enc === 'UCS-2') return 'utf16le';
      enc = StringPrototypeToLowerCase(enc);
      if (enc === 'utf-8') return 'utf8';
      if (enc === 'ascii') return 'ascii';
      if (enc === 'ucs-2') return 'utf16le';
      break;
    case 6:
      if (enc === 'base64') return 'base64';
      if (enc === 'latin1' || enc === 'binary') return 'latin1';
      if (enc === 'BASE64') return 'base64';
      if (enc === 'LATIN1' || enc === 'BINARY') return 'latin1';
      enc = StringPrototypeToLowerCase(enc);
      if (enc === 'base64') return 'base64';
      if (enc === 'latin1' || enc === 'binary') return 'latin1';
      break;
    case 7:
      if (enc === 'utf16le' || enc === 'UTF16LE' ||
      StringPrototypeToLowerCase(enc) === 'utf16le')
        return 'utf16le';
      break;
    case 8:
      if (enc === 'utf-16le' || enc === 'UTF-16LE' ||
      StringPrototypeToLowerCase(enc) === 'utf-16le')
        return 'utf16le';
      break;
    case 9:
      if (enc === 'base64url' || enc === 'BASE64URL' ||
      StringPrototypeToLowerCase(enc) === 'base64url')
        return 'base64url';
      break;
    default:
      if (enc === '') return 'utf8';
  }
}


function once(callback, { preserveReturnValue = false } = kEmptyObject) {
  let called = false;
  let returnValue;
  return function(...args) {
    if (called) return returnValue;
    called = true;
    const result = ReflectApply(callback, this, args);
    returnValue = preserveReturnValue ? result : undefined;
    return result;
  };
}


function assignFunctionName(name, fn, descriptor = kEmptyObject) {
  if (typeof name !== 'string') {
    const symbolDescription = SymbolPrototypeGetDescription(name);
    assert(symbolDescription !== undefined, 'Attempted to name function after descriptionless Symbol');
    name = `[${symbolDescription}]`;
  }
  return ObjectDefineProperty(fn, 'name', {
    __proto__: null,
    writable: false,
    enumerable: false,
    configurable: true,
    ...ObjectGetOwnPropertyDescriptor(fn, 'name'),
    ...descriptor,
    value: name,
  });
}


const experimentalWarnings = new SafeSet();

function emitExperimentalWarning(feature, messagePrefix, code, ctor) {
  if (experimentalWarnings.has(feature)) return;
  experimentalWarnings.add(feature);
  let msg = `${feature} is an experimental feature and might change at any time`;
  if (messagePrefix) {
    msg = messagePrefix + msg;
  }
  process.emitWarning(msg, 'ExperimentalWarning', code, ctor);
}

function deprecateInstantiation(target, code, ...args) {
  assert(typeof code === 'string');

  getDeprecationWarningEmitter(code, `Instantiating ${target.name} without the 'new' keyword has been deprecated.`, target)();

  return ReflectConstruct(target, args);
}

function deprecate(fn, msg, code, useEmitSync, modifyPrototype = true) {
  // Lazy-load to avoid a circular dependency.
  if (validateString === undefined)
    ({ validateString } = require('internal/validators'));

  if (code !== undefined)
    validateString(code, 'code');

  const emitDeprecationWarning = getDeprecationWarningEmitter(
    code, msg, deprecated, useEmitSync,
  );

  function deprecated(...args) {
    if (!process.noDeprecation) {
      emitDeprecationWarning();
    }
    if (new.target) {
      return ReflectConstruct(fn, args, new.target);
    }
    return ReflectApply(fn, this, args);
  }

  if (modifyPrototype) {
    // The wrapper will keep the same prototype as fn to maintain prototype chain
    // Modifying the prototype does alter the object chains, and as observed in
    // most cases, it slows the code.
    ObjectSetPrototypeOf(deprecated, fn);
    if (fn.prototype) {
      // Setting this (rather than using Object.setPrototype, as above) ensures
      // that calling the unwrapped constructor gives an instanceof the wrapped
      // constructor.
      deprecated.prototype = fn.prototype;
    }

    ObjectDefineProperty(deprecated, 'length', {
      __proto__: null,
      ...ObjectGetOwnPropertyDescriptor(fn, 'length'),
    });
  }

  return deprecated;
}

const kCustomPromisifiedSymbol = SymbolFor('nodejs.util.promisify.custom');
const kCustomPromisifyArgsSymbol = Symbol('customPromisifyArgs');

let validateFunction;

function promisify(original) {
  // Lazy-load to avoid a circular dependency.
  if (validateFunction === undefined)
    ({ validateFunction } = require('internal/validators'));

  validateFunction(original, 'original');

  if (original[kCustomPromisifiedSymbol]) {
    const fn = original[kCustomPromisifiedSymbol];

    validateFunction(fn, 'util.promisify.custom');

    return ObjectDefineProperty(fn, kCustomPromisifiedSymbol, {
      __proto__: null,
      value: fn, enumerable: false, writable: false, configurable: true,
    });
  }

  // Names to create an object from in case the callback receives multiple
  // arguments, e.g. ['bytesRead', 'buffer'] for fs.read.
  const argumentNames = original[kCustomPromisifyArgsSymbol];

  function fn(...args) {
    return new Promise((resolve, reject) => {
      ArrayPrototypePush(args, (err, ...values) => {
        if (err) {
          return reject(err);
        }
        if (argumentNames !== undefined && values.length > 1) {
          const obj = {};
          for (let i = 0; i < argumentNames.length; i++)
            obj[argumentNames[i]] = values[i];
          resolve(obj);
        } else {
          resolve(values[0]);
        }
      });
      if (isPromise(ReflectApply(original, this, args))) {
        process.emitWarning('Calling promisify on a function that returns a Promise is likely a mistake.',
                            'DeprecationWarning', 'DEP0174');
      }
    });
  }

  ObjectSetPrototypeOf(fn, ObjectGetPrototypeOf(original));

  ObjectDefineProperty(fn, kCustomPromisifiedSymbol, {
    __proto__: null,
    value: fn, enumerable: false, writable: false, configurable: true,
  });

  const descriptors = ObjectGetOwnPropertyDescriptors(original);
  const propertiesValues = ObjectValues(descriptors);
  for (let i = 0; i < propertiesValues.length; i++) {
    // We want to use null-prototype objects to not rely on globally mutable
    // %Object.prototype%.
    ObjectSetPrototypeOf(propertiesValues[i], null);
  }
  return ObjectDefineProperties(fn, descriptors);
}

promisify.custom = kCustomPromisifiedSymbol;


function convertProcessSignalToExitCode(signalCode) {
  // Lazy-load to avoid a circular dependency.
  if (validateOneOf === undefined)
    ({ validateOneOf } = require('internal/validators'));

  validateOneOf(signalCode, 'signalCode', ObjectKeys(signals));

  // POSIX standard: exit code for signal termination is 128 + signal number.
  return 128 + signals[signalCode];
}

let signalsToNamesMapping;
function getSignalsToNamesMapping() {
  if (signalsToNamesMapping !== undefined)
    return signalsToNamesMapping;

  signalsToNamesMapping = { __proto__: null };
  for (const key in signals) {
    signalsToNamesMapping[signals[key]] = key;
  }

  return signalsToNamesMapping;
}

function convertToValidSignal(signal) {
  if (typeof signal === 'number' && getSignalsToNamesMapping()[signal])
    return signal;

  if (typeof signal === 'string') {
    const signalName = signals[StringPrototypeToUpperCase(signal)];
    if (signalName) return signalName;
  }

  throw new ERR_UNKNOWN_SIGNAL(signal);
}
