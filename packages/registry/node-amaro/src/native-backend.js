// Private native glue replacing lib/wasm.js. The public transform wrapper,
// coercion/default/spread order, original transform_sync and Serde algorithms
// remain upstream. These operations express the generated glue's JS actions.
const binding = internalBinding('amaro');

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function type(value, tag) {
  if (tag === 0) {
    if (value === undefined) return 0;
    if (value === null) return 1;
    switch (typeof value) {
      case 'boolean': return 2;
      case 'number': return 3;
      case 'string': return 4;
      case 'bigint': return 5;
      case 'object': return 6;
      case 'function': return 7;
      default: return 8;
    }
  }
  if (tag === 1) return +(typeof value === 'string');
  if (tag === 2) return +Array.isArray(value);
  if (tag === 6) return +(typeof value === 'object' && value !== null);
  if (tag === 7) return +(typeof value === 'symbol');
  try {
    if (tag === 3) return +(value instanceof Uint8Array);
    if (tag === 4) return +(value instanceof ArrayBuffer);
    if (tag === 5) return +(value instanceof Map);
    if (tag === 8) return +(value instanceof Error);
  } catch (_) { return 0; }
  throw new Error('Invalid native Amaro type operation');
}

const operations = [
  undefined,
  type,                                      // 1 TYPE
  value => typeof value === 'boolean' ? +value : value,
  undefined, undefined, undefined, undefined, // native string/number primitives
  value => BigInt(value),                     // 7 NEW_BIGINT
  value => `${value}`,
  (left, right) => left == right,
  (key, value) => key in value,
  (value, key) => value[key],
  (value, key, item) => { value[key] = item; },
  () => new Object(),
  value => Object.entries(value),
  () => new Array(),
  value => value.length,
  (value, index) => value[index],
  (value, index, item) => { value[index] = item; },
  value => Array.from(value),
  value => Number.isSafeInteger(value),
  () => new Map(),
  (value, key, item) => value.set(key, item),
  () => Symbol.iterator,
  value => {
    const method = Reflect.get(value, Symbol.iterator);
    if (typeof method !== 'function') return undefined;
    const iterator = method.call(value);
    if (iterator === null || typeof iterator !== 'object' ||
        typeof iterator.next !== 'function') return undefined;
    return iterator;
  },
  iterator => {
    const result = iterator.next();
    const done = !!result.done;
    return [done, done ? undefined : result.value];
  },
  value => value,                             // 26 NEW_BYTES, copied by native caller
  value => value.length,
  (value, length) => { const copy = new Uint8Array(length); copy.set(value); return copy; },
  value => new Uint8Array(value),
  message => new Error(message),
  value => String(value),
  debugString,
  value => value.toString(),
  value => !value,
  value => value.length,
  (value, index) => value.codePointAt(index),
];
export default {
  transformSync(source, options) {
    return binding.transformSync(source, options, operations);
  },
};
