'use strict';
// Same public API assertions run unchanged on exact native Node and the guest.
const assert = require('node:assert/strict');
const sqlite = require('node:sqlite');
function withDB(run) { const db = new sqlite.Database(':memory:'); try { return run(db); } finally { if (db.isOpen) db.close(); } }
function failure(run) { try { run(); return 'no error'; } catch (error) { return [error.name, error.code, error.message]; } }
function plain(value) { return ArrayBuffer.isView(value) ? Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  : typeof value === 'number' && !Number.isFinite(value) ? { number: String(value) } : value; }
const cases = {
  scalar() { return withDB(db => {
    const receivers = [];
    db.function('describe', function(a, b, c, d, e) {
      receivers.push(this === undefined);
      assert.deepEqual([a, b, c, Array.from(d), e], [3, 1.25, 'é\0x', [0,255], null]);
      return a + b;
    });
    const row = db.prepare("SELECT describe(3,1.25,CAST(x'c3a90078' AS TEXT),x'00ff',NULL) AS value").get();
    assert.equal(row.value, 4.25);
    db.function('big', { useBigIntArguments: true }, x => { assert.equal(typeof x, 'bigint'); return x; });
    const big = db.prepare('SELECT big(9223372036854775807) AS value', { readBigInts: true }).get().value;
    assert.equal(big, 9223372036854775807n);
    db.function('safe', x => x);
    const range = failure(() => db.prepare('SELECT safe(9007199254740992)').get());
    assert.equal(range[1], 'ERR_OUT_OF_RANGE');
    return [row.value, String(big), receivers, range];
  }); },
  returns() { return withDB(db => {
    const shared = new SharedArrayBuffer(5), growable = new SharedArrayBuffer(5, { maxByteLength: 10 });
    const resizable = new ArrayBuffer(5, { maxByteLength: 10 });
    for (const bytes of [shared, growable, resizable]) new Uint8Array(bytes).set([9,0,255,1,8]);
    const detached = new ArrayBuffer(3), detachedView = new Uint8Array(detached);
    structuredClone(detached, { transfer: [detached] });
    const inputs = [undefined, null, 1.5, NaN, Infinity, -Infinity, 'é\0x', 7n,
      new Uint8Array([0,255]), new DataView(shared, 1, 3), shared, growable, resizable,
      new Uint8Array(resizable, 1, 3), new ArrayBuffer(0), new Uint8Array(0),
      new SharedArrayBuffer(0), new ArrayBuffer(0, { maxByteLength: 8 }),
      new SharedArrayBuffer(0, { maxByteLength: 8 }), detached, detachedView];
    const result = [];
    for (let i = 0; i < inputs.length; ++i) {
      db.function('value_' + i, () => inputs[i]);
      const row = db.prepare('SELECT typeof(value_' + i + '()) AS kind, value_' + i + '() AS value').get();
      result.push([row.kind, plain(row.value)]);
    }
    return result;
  }); },
  policies() { return withDB(db => {
    const order = [], options = {};
    for (const name of ['useBigIntArguments', 'varargs', 'deterministic', 'directOnly'])
      Object.defineProperty(options, name, { get() { order.push(name); return false; } });
    const fn = x => x;
    Object.defineProperty(fn, 'length', { get() { order.push('length'); return 1; } });
    db.function('ordered', options, fn);
    assert.deepEqual(order, ['useBigIntArguments','varargs','deterministic','directOnly','length']);
    db.function('variadic', { varargs: true }, (...args) => args.length);
    assert.equal(db.prepare('SELECT variadic(1,2,3) AS n').get().n, 3);
    db.function('double_it', { deterministic: true }, x => x*2);
    db.exec('CREATE TABLE t(x); CREATE INDEX idx ON t(double_it(x)); INSERT INTO t VALUES(2)');
    db.function('direct', { directOnly: true }, () => 1);
    db.exec('CREATE VIEW restricted AS SELECT direct() AS value');
    assert.throws(() => db.prepare('SELECT * FROM restricted').get(), { code: 'ERR_SQLITE_ERROR' });
    const lengths = [];
    for (const length of [-1, -0, 0, 1.5, NaN, Infinity, '1', null]) {
      const fn = () => 1; Object.defineProperty(fn, 'length', { value: length });
      lengths.push(failure(() => db.function('arity', fn)));
    }
    return [order, lengths];
  }); },
  exceptions() { return withDB(db => {
    const primary = { marker: 'primary' };
    db.function('thrower', () => { throw primary; });
    assert.throws(() => db.prepare('SELECT thrower()').get(), error => error === primary);
    const errors = [];
    for (const [name, value] of [['boolean', true], ['object', {}], ['symbol', Symbol('x')],
      ['promise', Promise.resolve(1)], ['big', 9223372036854775808n]]) {
      db.function(name, () => value);
      const error = failure(() => db.prepare('SELECT '+name+'()').get());
      assert.equal(error[1], 'ERR_SQLITE_ERROR'); errors.push(error);
    }
    db.function('thrower', () => 42); assert.equal(db.prepare('SELECT thrower() AS x').get().x, 42);
    return errors;
  }); },
  reentry() { return withDB(db => {
    const other = db.prepare('SELECT 9 AS value'); let statement, blocked;
    db.function('reenter', () => {
      const value = other.get().value;
      try { db.close(); } catch (error) { blocked = error.code; }
      assert.equal(blocked, 'ERR_INVALID_STATE');
      assert.throws(() => statement.get(), { code: 'ERR_INVALID_STATE' });
      return value;
    });
    statement = db.prepare('SELECT reenter() AS value');
    assert.equal(statement.get().value, 9);
    const closing = () => 1;
    Object.defineProperty(closing, 'length', { get() { db.close(); return 0; } });
    assert.throws(() => db.function('closed_during_getter', closing), { code: 'ERR_INVALID_STATE' });
    return blocked;
  }); },
  aggregate() { return withDB(db => {
    const receivers = []; let starts = 0;
    db.aggregate('sum_values', {
      start() { receivers.push(this === null); ++starts; return { sum: 0 }; },
      step(state, value) { receivers.push(this === undefined); state.sum += value; return state; },
      result(state) { receivers.push(this === null); return state.sum; },
    });
    db.exec('CREATE TABLE t(g,x); INSERT INTO t VALUES(1,2),(1,3),(2,7)');
    const rows = db.prepare('SELECT g, sum_values(x) AS value FROM t GROUP BY g ORDER BY g').all();
    assert.deepEqual(rows.map(row => row.value), [5,7]); assert.equal(starts, 2); assert.ok(receivers.every(Boolean));
    const empty = db.prepare('SELECT sum_values(x) AS value FROM t WHERE 0').get().value;
    assert.equal(empty, 0); assert.equal(starts, 3);
    return [rows, empty, starts, receivers];
  }); },
  window() { return withDB(db => {
    const calls = [];
    db.aggregate('rolling', { start: 0n, useBigIntArguments: true,
      step(sum, value) { calls.push(['step', String(value)]); return sum + value; },
      inverse(sum, value) { calls.push(['inverse', String(value)]); return sum - value; },
      result(sum) { calls.push(['result', String(sum)]); return sum; },
    });
    db.exec('CREATE TABLE t(x); INSERT INTO t VALUES(1),(2),(3)');
    const rows = db.prepare('SELECT rolling(x) OVER (ORDER BY x ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS value FROM t', { readBigInts: true }).all();
    assert.deepEqual(rows.map(row => row.value), [1n,3n,5n]);
    const iterator = db.prepare('SELECT rolling(x) OVER (ORDER BY x ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS value FROM t').iterate();
    assert.equal(iterator.next().value.value, 1); iterator.return();
    return [rows.map(row => String(row.value)), calls];
  }); },
  aggregateErrors() { return withDB(db => {
    const primary = { marker: 'aggregate' }, counts = [];
    for (const phase of ['start', 'step', 'result', 'inverse']) {
      let thrown = 0;
      const fail = (sum, value) => { ++thrown; throw primary; };
      const name = 'broken_' + phase;
      db.aggregate(name, { start: phase === 'start' ? fail : 0,
        step: phase === 'step' ? fail : (sum,value) => sum+value,
        result: phase === 'result' ? fail : value => value,
        ...(phase === 'inverse' ? { inverse: fail } : {}) });
      const sql = phase === 'inverse' ? 'SELECT '+name+'(x) OVER (ORDER BY x ROWS BETWEEN CURRENT ROW AND CURRENT ROW) FROM (SELECT 1 AS x UNION ALL SELECT 2)' : 'SELECT '+name+'(1)';
      assert.throws(() => db.prepare(sql).all(), error => error === primary);
      assert.ok(thrown > 0);
      counts.push([phase, thrown]);
    }
    return counts;
  }); },
  session() { console.log('SESSION_PHASE:loaded'); return withDB(source => withDB(target => {
    console.log('SESSION_PHASE:opened');
    const sql = 'CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT)'; source.exec(sql); target.exec(sql);
    console.log('SESSION_PHASE:schema');
    const session = source.createSession({ table: 't' }); console.log('SESSION_PHASE:created');
    source.exec("INSERT INTO t VALUES(1,'value')"); let blocked;
    console.log('SESSION_PHASE:inserted'); const changeset = session.changeset(); console.log('SESSION_PHASE:changeset');
    assert.equal(target.applyChangeset(changeset, { filter(name) {
      assert.equal(name, 't'); try { target.close(); } catch(error) { blocked = error.code; } return true;
    } }), true);
    console.log('SESSION_PHASE:applied'); assert.equal(blocked, 'ERR_INVALID_STATE'); session.close();
    return target.prepare('SELECT * FROM t').all();
  })); },
};
const name = process.argv[1];
if (!Object.hasOwn(cases, name)) throw Error('Unknown SQLite control: ' + name);
console.log('CONTROL_RESULT:' + JSON.stringify(cases[name]()));
