'use strict';

require('../common');
const assert = require('node:assert/strict');
const path = require('node:path');

const functions = {
  resolve: 0, normalize: 1, isAbsolute: 1, join: 0, relative: 2, toNamespacedPath: 1,
  dirname: 1, basename: 2, extname: 1, format: 1, parse: 1, matchesGlob: 2,
};
const keys = [...Object.keys(functions), 'sep', 'delimiter', 'win32', 'posix', '_makeLong'];

assert.strictEqual(path, process.platform === 'win32' ? path.win32 : path.posix);
assert.strictEqual(require('node:path/posix'), path.posix);
assert.strictEqual(require('node:path/win32'), path.win32);
assert.notStrictEqual(path.posix, path.win32);
for (const [namespace, sep, delimiter] of [[path.posix, '/', ':'], [path.win32, '\\', ';']]) {
  assert.deepStrictEqual(Reflect.ownKeys(namespace), keys);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(namespace, key);
    assert.deepStrictEqual(descriptor, {
      value: namespace[key], writable: true, enumerable: true, configurable: true,
    });
  }
  for (const [name, length] of Object.entries(functions)) {
    assert.strictEqual(typeof namespace[name], 'function');
    assert.strictEqual(namespace[name].length, length);
    assert.strictEqual(namespace[name].name, name === 'format' ? 'bound _format' : name);
  }
  assert.strictEqual(namespace.sep, sep);
  assert.strictEqual(namespace.delimiter, delimiter);
  assert.strictEqual(namespace.posix, path.posix);
  assert.strictEqual(namespace.win32, path.win32);
  assert.strictEqual(namespace._makeLong, namespace.toNamespacedPath);
}
