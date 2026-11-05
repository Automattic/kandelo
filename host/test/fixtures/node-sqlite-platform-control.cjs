'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const util = require('node:util');
const { constants: osConstants } = require('node:os');
const { markAsUncloneable } = require('node:worker_threads');
const sqlite = require('node:sqlite');
const root = path.resolve(__dirname, '../../..');
const target = JSON.parse(fs.readFileSync(path.join(root, 'packages/registry/node-compat/target.json')));
assert.equal(process.versions.node, target.version);
const bundle = fs.readFileSync(path.join(root, 'third_party/node-core/node-core.js'), 'utf8');
const factories = Function(bundle + ';return {sqlite:_createNodeSqlitePlatform,values:_createNodeValuesPlatform};')();
const parameterTool = process.argv[2], work = process.argv[3];
let serial = 0;
const decoder = new TextDecoder(), encoder = new TextEncoder();
const limitNames = [...fs.readFileSync(path.join(root, 'third_party/node-core/upstream/sqlite/node_sqlite.h'), 'utf8').matchAll(/\{"([^"]+)", SQLITE_LIMIT_[A-Z_]+\}/g)].map(match => match[1]);
// Reference boundary only: real native Node DBs/iterators/columns and a
// compiled exact-SQLite parameter inspector. No SQL regex, simulated query,
// guest C++ binding or platform identity substitution is used by the product.
function native(operation, owner, first, second) {
  if (operation === 'create') {
    const db = new sqlite.Database(owner, { open: first.open, readOnly: first.readOnly,
      enableForeignKeyConstraints: first.foreignKeys, enableDoubleQuotedStringLiterals: first.doubleQuotedStrings,
      defensive: first.defensive, timeout: first.timeout,
      limits: Object.fromEntries(limitNames.map((name, i) => [name, first.limits[i]]).filter(([, value]) => value !== undefined)) });
    return { db, filename: owner };
  }
  if (operation === 'open' || operation === 'close') return owner.db[operation]();
  if (operation === 'checkDatabase') { if (!owner.db.isOpen) throw Object.assign(Error('database is not open'), { code: 'ERR_INVALID_STATE' }); return; }
  if (operation === 'checkStatement') { owner.stmt.columns(); return; }
  if (operation === 'columns') return owner.stmt.columns().map(c => [c.column, c.database, c.name, c.table, c.type]);
  if (operation === 'limits') return owner.db.limits;
  if (operation === 'limit') return owner.db.limits[limitNames[first]];
  if (operation === 'setLimit') { owner.db.limits[limitNames[first]] = second; return; }
  if (operation === 'defensive') return owner.db.enableDefensive(first);
  if (operation === 'createSession') return owner.db.createSession({ db: first, table: second });
  if (operation === 'sessionChangeset') return first ? owner.patchset() : owner.changeset();
  if (operation === 'closeSession') return first ? owner[Symbol.dispose]() : owner.close();
  if (operation === 'applyChangeset') return owner.db.applyChangeset(first, { ...(second ? { filter: second } : {}), onConflict: arguments[4] });
  if (operation === 'isOpen' || operation === 'isTransaction') return owner.db[operation];
  if (operation === 'location') return owner.db.location(first);
  if (operation === 'exec') return owner.db.exec(first);
  if (operation === 'prepare') {
    const stmt = owner.db.prepare(first, { readBigInts: true, persistent: second });
    const inspected = spawnSync(parameterTool, [owner.filename, first], { encoding: 'utf8', timeout: 5000 });
    assert.equal(inspected.status, 0, inspected.stderr);
    const parameters = JSON.parse(inspected.stdout).map(name => Buffer.from(name, 'latin1').toString('utf8'));
    return { stmt, db: owner.db, values: [], iterator: null, parameters };
  }
  if (operation === 'reset') {
    if (owner.iterator) owner.iterator.return();
    owner.iterator = null;
    if (first) owner.values = [];
    return;
  }
  if (operation === 'bind') { owner.values[first - 1] = second; return; }
  if (operation === 'parameters') return owner.parameters;
  if (operation === 'names') return owner.stmt.columns().map(column => column.name);
  if (operation === 'sourceSQL' || operation === 'expandedSQL') return owner.stmt[operation];
  if (operation === 'changes' || operation === 'lastInsertRowid') {
    const column = operation === 'changes' ? 'changes()' : 'last_insert_rowid()';
    return owner.db.prepare(`SELECT ${column} AS n`, { readBigInts: true }).get().n;
  }
  if (operation === 'step' || operation === 'stepDiscard') {
    if (!owner.iterator) {
      const named = Object.create(null), args = [];
      for (let i = 0; i < owner.parameters.length; i++) {
        const name = owner.parameters[i];
        if (name && name[0] !== '?') named[name] = owner.values[i];
        else args.push(owner.values[i]);
      }
      owner.iterator = owner.stmt.iterate(named, ...args);
    }
    const next = owner.iterator.next();
    if (operation === 'stepDiscard') return !next.done;
    if (next.done) return null;
    return owner.stmt.columns().map(column => {
      const value = next.value[column.name];
      return value === null ? [5, null] : typeof value === 'bigint' ? [1, value]
        : typeof value === 'number' ? [2, value] : typeof value === 'string' ? [3, encoder.encode(value)] : [4, value];
    });
  }
  throw Error('Unknown reference boundary operation: ' + operation);
}
const values = factories.values({ process, Buffer, util, inspection: util, os: {}, signals: osConstants.signals });
const candidate = factories.sqlite({ native: { sqlite: native }, values, util, Buffer, TextDecoder, URL,
  fileURLToPath: require('node:url').fileURLToPath, markUncloneable: markAsUncloneable, constants: sqlite.constants });
const outcomes = [];
function test(name, control) {
  try { control(); outcomes.push({ name, pass: true }); }
  catch (error) { outcomes.push({ name, pass: false, error: String(error), stack: error.stack }); }
}
function withDb(api, run) {
  const filename = path.join(work, `db-${serial++}.sqlite`), db = new api.Database(filename);
  try { return run(db); } finally { if (db.isOpen) db.close(); }
}
test('aliases-and-private-owners', () => {
  assert.equal(candidate.Database, candidate.DatabaseSync); assert.equal(candidate.Statement, candidate.StatementSync);
  withDb(candidate, db => {
    const stmt = db.prepare('SELECT 1'); assert.equal(stmt instanceof candidate.Statement, true);
    assert.throws(() => structuredClone(db), { name: 'DataCloneError' });
    assert.throws(() => structuredClone(stmt), { name: 'DataCloneError' });
  });
});
test('actual-SQL-types-and-configuration', () => {
  function run(api) { return withDb(api, db => {
    db.exec('CREATE TABLE t(i INTEGER,t TEXT,b BLOB,r REAL)');
    const info = db.prepare('INSERT INTO t VALUES(:i,?,?,?)').run({ i: 9007199254740993n }, 'é\0z', new Uint8Array([0, 255]), 1.25);
    const stmt = db.prepare('SELECT * FROM t', { readBigInts: true });
    const row = stmt.get(); stmt.setReturnArrays(true); const array = stmt.get();
    return { info, row, array, foreignKeys: db.prepare('PRAGMA foreign_keys').get(), isOpen: db.isOpen };
  }); }
  assert.deepEqual(run(candidate), run(sqlite));
});
test('binding-forms-and-live-schema-metadata', () => {
  function run(api) { return withDb(api, db => {
    db.exec('CREATE TABLE t(x); INSERT INTO t VALUES(2)'); const stmt = db.prepare('SELECT * FROM t');
    db.exec('ALTER TABLE t ADD COLUMN y; UPDATE t SET y=3');
    const row = stmt.get(); const values = db.prepare('SELECT ? a,? b,? c').get(true, undefined, new ArrayBuffer(0));
    return { row, values, names: db.prepare('SELECT :name AS x').get({ ':name': 'value' }) };
  }); }
  assert.deepEqual(run(candidate), run(sqlite));
});
test('transactions-and-closed-state', () => {
  function run(api) { return withDb(api, db => {
    db.exec('BEGIN'); const first = db.isTransaction; db.exec('ROLLBACK'); const last = db.isTransaction;
    const stmt = db.prepare('SELECT 1'); db.close(); let code;
    try { stmt.get(); } catch (error) { code = error.code; }
    db.open(); return { first, last, code, tables: db.prepare('SELECT count(*) AS n FROM sqlite_master').get().n };
  }); }
  assert.deepEqual(run(candidate), run(sqlite));
});
test('live-iterator-reset-invalidation-and-metadata', () => {
  function run(api) { return withDb(api, db => {
    db.exec("CREATE TABLE rows(id INTEGER PRIMARY KEY, label TEXT); INSERT INTO rows VALUES(1,'one'),(2,'two'),(3,'three')");
    const stmt = db.prepare('SELECT id, label, id + 1 AS expression FROM rows ORDER BY id');
    const columns = stmt.columns();
    const iter = stmt.iterate(); const first = iter.next();
    assert.equal(iter[Symbol.iterator](), iter); assert.equal(Object.getPrototypeOf(first), null);
    const old = iter; const current = stmt.iterate(); let invalidated;
    try { old.next(); } catch (error) { invalidated = [error.code, error.message]; }
    const limited = current.take(1).toArray(); const done = current.next();
    const fresh = [...stmt.iterate()]; const terminal = stmt.iterate(); terminal.return();
    const repeat = terminal.next(); const descriptor = Object.getOwnPropertyDescriptors(first);
    db.close(); let closed;
    try { terminal.next(); } catch (error) { closed = error.code; }
    return { columns, first, invalidated, limited, done, fresh, repeat, closed,
      resultKeys: Object.keys(first), writable: descriptor.done.writable, valueEnumerable: descriptor.value.enumerable };
  }); }
  assert.deepEqual(run(candidate), run(sqlite));
});
test('actual-live-limits-defensive-and-reopen-state', () => {
  function run(api) {
    const db = new api.Database(path.join(work, `limits-${serial++}.sqlite`), { limits: { column: 4, sqlLength: 10000 } });
    try {
      const limits = db.limits; assert.equal(limits, db.limits);
      const keys = Object.keys(limits), descriptor = Object.getOwnPropertyDescriptor(limits, 'column');
      limits.column = 2; let denied;
      try { db.prepare('SELECT 1,2,3'); } catch (error) { denied = error.code; }
      const lowered = limits.column; limits.column = Infinity; const reset = limits.column > 2;
      limits.column = 3; limits.extra = 7; const removed = Reflect.deleteProperty(limits, 'column');
      db.enableDefensive(false); db.exec('PRAGMA writable_schema=ON'); const writable = db.prepare('PRAGMA writable_schema').get();
      db.close(); let closed;
      try { limits.column; } catch (error) { closed = error.code; }
      db.open(); const reopened = limits.column;
      return { keys, descriptor, denied, lowered, reset, removed, extra: limits.extra, writable, closed, reopened };
    } finally { if (db.isOpen) db.close(); }
  }
  assert.deepEqual(run(candidate), run(sqlite));
});
test('session-changeset-patchset-conflict-filter-and-close', () => {
  function run(api) {
    const source = new api.Database(path.join(work, `source-${serial++}.sqlite`)), target = new api.Database(path.join(work, `target-${serial++}.sqlite`));
    try {
      const schema = 'CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT)'; source.exec(schema); target.exec(schema);
      const session = source.createSession({ table: 't' });
      assert.equal(session instanceof api.Session, true);
      source.exec("INSERT INTO t VALUES(1,'one'),(2,'two'); UPDATE t SET value='second' WHERE id=2");
      const changeset = session.changeset(), patchset = session.patchset();
      const calls = []; const first = target.applyChangeset(changeset, { filter(table) { calls.push(table); return true; } });
      const conflict = target.applyChangeset(changeset); const codes = [];
      const replaced = target.applyChangeset(changeset, { onConflict(type) { codes.push(type); return api.constants.SQLITE_CHANGESET_REPLACE; } });
      const data = target.prepare('SELECT * FROM t ORDER BY id').all();
      session.close(); let closed; try { session.changeset(); } catch (error) { closed = [error.code, error.message]; }
      session[Symbol.dispose](); const remaining = source.createSession(); source.close();
      remaining[Symbol.dispose](); let databaseClosed; try { remaining.patchset(); } catch (error) { databaseClosed = error.code; }
      return { first, conflict, replaced, data, calls, codes, closed, databaseClosed,
        changeset: Buffer.from(changeset).toString('hex'), patchset: Buffer.from(patchset).toString('hex') };
    } finally { if (source.isOpen) source.close(); if (target.isOpen) target.close(); }
  }
  assert.deepEqual(run(candidate), run(sqlite));
});
test('changeset-callback-reentry-primary-exception-and-owned-input', () => {
  function run(api) {
    const source = new api.Database(path.join(work, `source-${serial++}.sqlite`)), target = new api.Database(path.join(work, `target-${serial++}.sqlite`));
    try {
      source.exec('CREATE TABLE t(id INTEGER PRIMARY KEY)'); target.exec('CREATE TABLE t(id INTEGER PRIMARY KEY)');
      const session = source.createSession(); source.exec('INSERT INTO t VALUES(1),(2)');
      const bytes = session.changeset(), error = Error('callback primary'); let same = false, closeGuard;
      try { target.applyChangeset(bytes, { filter() { try { target.close(); } catch (e) { closeGuard = e.code; } throw error; } }); }
      catch (caught) { same = caught === error; }
      assert.equal(target.isOpen, true);
      const detached = session.changeset();
      const applied = target.applyChangeset(detached, { filter() { structuredClone(detached.buffer, { transfer: [detached.buffer] }); return true; } });
      const result = { same, closeGuard, applied, detached: detached.byteLength,
        rows: target.prepare('SELECT * FROM t ORDER BY id').all() };
      return result;
    } finally { source.close(); target.close(); }
  }
  assert.deepEqual(run(candidate), run(sqlite));
});
test('unsupported-features-remain-explicit', () => withDb(candidate, db => {
  for (const action of [() => db.function('x', () => 1),
    () => candidate.backup(db, 'backup.sqlite')]) {
    assert.throws(action, { code: 'ERR_NOT_IMPLEMENTED' });
  }
  assert.equal(typeof candidate.Session, 'function');
  assert.throws(() => new candidate.Session(), { code: 'ERR_ILLEGAL_CONSTRUCTOR' });
}));
console.log(JSON.stringify({ scope: 'Shared JS SQLite frontend over native Node/actual SQLite introspection boundaries; not guest engine/VFS or complete API conformance', outcomes }));
if (outcomes.some(result => !result.pass)) process.exitCode = 1;
