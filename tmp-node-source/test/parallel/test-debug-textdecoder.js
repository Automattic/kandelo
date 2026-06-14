'use strict';

const decodeFn = TextDecoder.prototype.decode;
const inspectSymbol = Symbol.for('nodejs.util.inspect.custom');
const inspectFn = TextDecoder.prototype[inspectSymbol];
const {
  encoding: { get: encodingGetter },
  fatal: { get: fatalGetter },
  ignoreBOM: { get: ignoreBOMGetter },
} = Object.getOwnPropertyDescriptors(TextDecoder.prototype);
const values = [{}, [], true, 1, '', new TextEncoder()];
const checks = [
  ['inspect', (value) => inspectFn.call(value, Infinity, {})],
  ['decode', (value) => decodeFn.call(value)],
  ['encoding', (value) => encodingGetter.call(value)],
  ['fatal', (value) => fatalGetter.call(value)],
  ['ignoreBOM', (value) => ignoreBOMGetter.call(value)],
];
for (let i = 0; i < values.length; i++) {
  for (const [name, fn] of checks) {
    try {
      fn(values[i]);
      console.log('NO_THROW', name, i, Object.prototype.toString.call(values[i]),
        Object.getPrototypeOf(Object(values[i])) === TextDecoder.prototype,
        values[i] instanceof TextDecoder);
    } catch (err) {
      console.log('THROW', name, i, err && err.code, err && err.message);
    }
  }
}
