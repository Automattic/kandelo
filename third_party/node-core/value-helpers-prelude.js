const {
    Error, FunctionPrototypeSymbolHasInstance, ArrayPrototypePush, Promise, Symbol, SymbolFor,
    ObjectDefineProperty, ObjectDefineProperties, ObjectGetOwnPropertyDescriptors, ObjectGetPrototypeOf, ObjectValues,
    ObjectGetOwnPropertyDescriptor, ObjectKeys, ObjectSetPrototypeOf, ReflectApply, ReflectConstruct, SafeSet,
    StringPrototypeToLowerCase, StringPrototypeToUpperCase, SymbolPrototypeGetDescription,
} = primordials;
const { isNativeError, isPromise } = require('internal/util/types');
const assert = require('internal/assert');
const kEmptyObject = primordials.ObjectFreeze(primordials.ObjectCreate(null));
const { os: { signals } } = internalBinding('constants');
const { ERR_UNKNOWN_SIGNAL } = require('internal/errors').codes;
