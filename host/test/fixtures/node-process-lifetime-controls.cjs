'use strict';
// Identical public programs run with candidate preload and as native controls.
// They use natural process exit/idle transitions, not manufactured events.
module.exports = {
  descriptors: {
    source: String.raw`
      const assert = require('node:assert/strict');
      for (const name of ['ref', 'unref']) {
        const d = Object.getOwnPropertyDescriptor(process, name);
        assert.deepEqual([d.writable, d.enumerable, d.configurable], [true, true, true]);
        assert.equal(d.value.name, name); assert.equal(d.value.length, 1);
      }
      const d = Object.getOwnPropertyDescriptor(process, 'finalization');
      assert.deepEqual([d.enumerable, d.configurable, d.get.name, d.set.name], [true, true, 'get', 'set']);
      const f = process.finalization;
      assert.equal(process.finalization, f);
      assert.equal(Object.getPrototypeOf(f), Object.prototype);
      assert.deepEqual(Object.keys(f), ['register', 'registerBeforeExit', 'unregister']);
      for (const name of Object.keys(f)) {
        const d = Object.getOwnPropertyDescriptor(f, name);
        assert.deepEqual([d.writable, d.enumerable, d.configurable], [true, true, true]);
        assert.equal(d.value.name, name);
        assert.equal(d.value.length, name === 'unregister' ? 1 : 2);
      }
      process.finalization = null; assert.equal(process.finalization, null);
      process.finalization = 23; assert.equal(process.finalization, 23);
      process.finalization = undefined; assert.notEqual(process.finalization, f);
      assert.equal(process.finalization.register.name, 'register');
      console.log('DESCRIPTORS_OK');
    `,
    stdout: 'DESCRIPTORS_OK\n', exitCode: 0,
  },
  refableDispatch: {
    source: String.raw`
      const assert = require('node:assert/strict');
      for (const name of ['ref', 'unref']) {
        for (const value of [undefined, null, false, 0, 1n, 'x', Symbol('x'), {}]) {
          assert.equal(process[name](value), undefined);
        }
        const key = Symbol.for('nodejs.' + name), trace = [];
        let receiver;
        const proto = { get [key]() { trace.push('symbol'); return function() {
          receiver = this; trace.push('call'); return 99;
        }; } };
        const obj = Object.create(proto, { [name]: { get() { throw Error('must not read fallback'); } } });
        assert.equal(process[name](obj), undefined);
        assert.equal(receiver, obj); assert.deepEqual(trace, ['symbol', 'call']);
        for (const value of [false, 0, '', null, undefined]) {
          const trace = [], obj = { get [key]() { trace.push('symbol'); return value; },
            get [name]() { trace.push('legacy'); return function() { assert.equal(this, obj); trace.push('call'); }; } };
          assert.equal(process[name](obj), undefined);
          assert.deepEqual(trace, ['symbol', 'legacy', 'call']);
        }
        for (const value of [true, 1, 'truthy', {}]) {
          assert.equal(process[name]({ [key]: value, get [name]() { throw Error('truthy symbol prevents fallback'); } }), undefined);
        }
        const error = Error('primary');
        assert.throws(() => process[name]({ get [key]() { throw error; } }), e => e === error);
        assert.throws(() => process[name]({ [key]() { throw error; } }), e => e === error);
        assert.throws(() => process[name]({ get [name]() { throw error; } }), e => e === error);
      }
      const timer = setTimeout(() => { throw Error('timer not retired'); }, 10000);
      process.unref(timer); assert.equal(timer.hasRef(), false);
      process.ref(timer); assert.equal(timer.hasRef(), true); clearTimeout(timer);
      console.log('REFABLE_OK');
    `,
    stdout: 'REFABLE_OK\n', exitCode: 0,
  },
  registryValidationAndUnregister: {
    source: String.raw`
      const assert = require('node:assert/strict'), f = process.finalization;
      // No registry exists yet; unregister deliberately returns before validation.
      for (const value of [null, undefined, 1, 'x', Symbol('x')]) assert.equal(f.unregister(value), undefined);
      for (const name of ['register', 'registerBeforeExit']) {
        for (const value of [null, undefined, false, 1, 'x', 1n, Symbol('x')]) {
          assert.throws(() => f[name](value, () => {}), { code: 'ERR_INVALID_ARG_TYPE' });
        }
      }
      const before = [process.listenerCount('exit'), process.listenerCount('beforeExit')];
      const obj = {}, fn = function keptFunction() {};
      f.register(obj, () => { throw Error('unregistered object'); });
      f.register(obj, () => { throw Error('duplicate object'); });
      f.registerBeforeExit(obj, () => { throw Error('unregistered beforeExit'); });
      f.register(fn, () => { throw Error('function is a valid weak target'); });
      assert.deepEqual([process.listenerCount('exit'), process.listenerCount('beforeExit')], before.map(x => x + 1));
      assert.throws(() => f.unregister(1), TypeError);
      assert.equal(f.unregister(obj), undefined);
      assert.equal(process.listenerCount('beforeExit'), before[1]);
      f.unregister(fn); f.unregister(fn);
      assert.deepEqual([process.listenerCount('exit'), process.listenerCount('beforeExit')], before);
      console.log('REGISTRY_OK');
    `,
    stdout: 'REGISTRY_OK\n', exitCode: 0,
  },
  naturalIdleRevivalAndExit: {
    source: String.raw`
      const assert = require('node:assert/strict');
      const obj = {}, f = process.finalization, trace = [];
      f.registerBeforeExit(obj, (value, event) => {
        assert.equal(value, obj); assert.equal(event, 'beforeExit'); trace.push('final-before');
        setImmediate(() => { trace.push('revived'); process.exitCode = 0; });
      });
      f.register(obj, (value, event) => {
        assert.equal(value, obj); assert.equal(event, 'exit'); trace.push('final-exit');
      });
      let idle = 0;
      process.exitCode = 7;
      process.on('beforeExit', code => { trace.push('before:' + ++idle); assert.equal(code, idle === 1 ? 7 : 0); });
      process.on('exit', code => {
        assert.equal(code, 0); assert.equal(idle, 2);
        assert.deepEqual(trace, ['final-before', 'before:1', 'revived', 'before:2', 'final-exit']);
        console.log('NATURAL_IDLE_OK');
      });
    `,
    stdout: 'NATURAL_IDLE_OK\n', exitCode: 0,
  },
  explicitExit: {
    source: String.raw`
      const assert = require('node:assert/strict');
      const obj = {}, f = process.finalization;
      let ran = false;
      f.registerBeforeExit(obj, () => { throw Error('explicit exit must not emit beforeExit'); });
      f.register(obj, (value, event) => { assert.equal(value, obj); assert.equal(event, 'exit'); ran = true; });
      process.on('exit', code => { assert.equal(code, 9); assert.equal(ran, true); console.log('EXPLICIT_EXIT_OK'); });
      process.exit(9);
    `,
    stdout: 'EXPLICIT_EXIT_OK\n', exitCode: 9,
  },
  deferredCallbackError: {
    source: String.raw`
      const obj = {};
      process.finalization.register(obj, 7);
      console.log('REGISTRATION_ACCEPTED');
      process.on('exit', () => { throw Error('primary callback error must stop later listeners'); });
    `,
    stdout: 'REGISTRATION_ACCEPTED\n', exitCode: 1, stderr: 'TypeError: fn is not a function',
  },
};
