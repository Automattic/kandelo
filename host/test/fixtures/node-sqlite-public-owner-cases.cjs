'use strict';
module.exports.cases = {
  sqliteOwners: '(' + function sqliteOwners() {
    const assert = require('node:assert/strict'), sqlite = require('node:sqlite');
    const source = new sqlite.Database(':memory:', { limits: { column: 8 } }), target = new sqlite.Database(':memory:');
    try {
      const limits = source.limits; assert.equal(limits, source.limits);
      assert.equal(require('node:util').types.isProxy(limits), false);
      assert.equal(Object.getOwnPropertyDescriptor(limits, 'column').configurable, false);
      assert.equal(Reflect.deleteProperty(limits, 'column'), true); assert.equal(limits.column, 8);
      assert.equal(Reflect.defineProperty(limits, 'column', { value: 6 }), true); assert.equal(limits.column, 6);
      limits.extra = 7; assert.equal(Object.keys(limits)[0], 'extra');
      assert.equal(Object.keys(limits).length, 12); assert.equal(limits.extra, 7);
      limits['column\0extra'] = 99; assert.equal(limits.column, 6);
      const schema = 'CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT)'; source.exec(schema); target.exec(schema);
      const session = source.createSession({ table: 't' }); assert.ok(session instanceof sqlite.Session);
      source.exec("INSERT INTO t VALUES(1,'one'),(2,'two'); UPDATE t SET value='second' WHERE id=2");
      const stmt = source.prepare('SELECT id, value, id+1 AS expression FROM t ORDER BY id');
      assert.deepEqual(Object.values(stmt.columns()[1]), ['value', 'main', 'value', 't', 'TEXT']);
      const old = stmt.iterate(); assert.equal(old.next().value.id, 1);
      const current = stmt.iterate(); assert.throws(() => old.next(), { code: 'ERR_INVALID_STATE' });
      assert.equal(current.take(1).toArray().length, 1); assert.equal(current.next().done, true);
      assert.equal([...stmt.iterate()].length, 2);
      const bytes = session.changeset(); let closeGuard;
      const error = Error('actual callback exception');
      assert.throws(() => target.applyChangeset(bytes, { filter() {
        try { target.close(); } catch (caught) { closeGuard = caught.code; }
        throw error;
      } }), caught => caught === error);
      assert.equal(closeGuard, 'ERR_INVALID_STATE'); assert.equal(target.isOpen, true);
      const copy = session.changeset();
      assert.equal(target.applyChangeset(copy, { filter(table) {
        assert.equal(table, 't'); structuredClone(copy.buffer, { transfer: [copy.buffer] }); return true;
      } }), true);
      assert.equal(copy.byteLength, 0);
      assert.equal(target.prepare('SELECT count(*) AS n FROM t').get().n, 2);
      assert.equal(target.applyChangeset(session.changeset()), false);
      assert.equal(target.applyChangeset(session.patchset(), { onConflict() { return sqlite.constants.SQLITE_CHANGESET_REPLACE; } }), true);
      session.close(); assert.throws(() => session.changeset(), { code: 'ERR_INVALID_STATE' }); session[Symbol.dispose]();
      const remaining = source.createSession(); source.close(); remaining[Symbol.dispose]();
      assert.throws(() => limits.column, { code: 'ERR_INVALID_STATE' });
      assert.throws(() => stmt.columns(), { code: 'ERR_INVALID_STATE' });
      source.open(); assert.equal(limits.column, 6);
      console.log('SQLITE_PUBLIC_OWNERS_OK');
    } finally { if (source.isOpen) source.close(); if (target.isOpen) target.close(); }
  }.toString() + ')();',
  testTree: '(' + function testTree() {
    const assert = require('node:assert/strict'), test = require('node:test');
    let before = false, child = false;
    test.before(() => { before = true; });
    test('owned public tree', async context => {
      assert.equal(before, true); assert.equal(test.getTestContext(), context);
      context.plan(2); context.assert.strictEqual(await Promise.resolve(42), 42);
      await context.test('owned async child', async inner => {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(test.getTestContext(), inner); inner.assert.strictEqual(2 + 2, 4); child = true;
      });
    });
    test.skip('explicitly skipped body', () => { throw Error('skip body ran'); });
    test.after(() => { assert.equal(child, true); console.log('TEST_PUBLIC_TREE_OK'); });
  }.toString() + ')();',
  testFailure: '(' + function testFailure() {
    require('node:test')('intentional public assertion failure', context => context.assert.strictEqual('actual', 'expected'));
    console.log('TEST_PUBLIC_FAILURE_REGISTERED');
  }.toString() + ')();',
  idleRevival: '(' + function idleRevival() {
    const assert = require('node:assert/strict'); const events = [];
    process.exitCode = 7;
    process.on('beforeExit', code => {
      assert.equal(code, process.exitCode); events.push('before:' + code);
      if (events.length === 1) {
        process.nextTick(() => events.push('tick'));
        Promise.resolve().then(() => events.push('promise'));
        setImmediate(() => { events.push('immediate'); process.exitCode = 0; });
      } else {
        // A microtask alone must not manufacture another idle loop turn.
        Promise.resolve().then(() => events.push('last promise'));
      }
    });
    process.on('exit', code => {
      assert.equal(code, 0);
      assert.deepEqual(events, ['before:7', 'tick', 'promise', 'immediate', 'before:0', 'last promise']);
      console.log('IDLE_REVIVAL_OK');
    });
  }.toString() + ')();',
  sqliteDisabled: '(' + function sqliteDisabled() {
    const assert = require('node:assert/strict');
    assert.equal(require('node:module').isBuiltin('node:sqlite'), false);
    assert.throws(() => require('node:sqlite'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
    console.log('SQLITE_DISABLED_OK');
  }.toString() + ')();',
};
