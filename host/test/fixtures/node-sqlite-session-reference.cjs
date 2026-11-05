'use strict';
const assert = require('node:assert/strict');
const { Database, constants } = require('node:sqlite');
const source = new Database(':memory:', { limits: { column: 8 } }), target = new Database(':memory:');
const schema = 'CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT)';
source.exec(schema); target.exec(schema);
const metadata = source.prepare('SELECT id, value, id + 1 AS expression FROM t').columns();
assert.deepEqual(Object.values(metadata[1]), ['value', 'main', 'value', 't', 'TEXT']);
assert.deepEqual(Object.values(metadata[2]), [null, null, 'expression', null, null]);
assert.equal(source.limits.column, 8); source.limits.column = 2;
assert.throws(() => source.prepare('SELECT 1,2,3'), { code: 'ERR_SQLITE_ERROR' });
source.limits.column = Infinity; const resetLimit = source.limits.column > 2;
source.enableDefensive(false);
const session = source.createSession({ table: 't' });
source.exec("INSERT INTO t VALUES(1,'one'),(2,'two'); UPDATE t SET value='second' WHERE id=2");
const changeset = session.changeset(), patchset = session.patchset(); let filters = 0, conflicts = 0;
const first = target.applyChangeset(changeset, { filter(name) { assert.equal(name, 't'); ++filters; return true; } });
const duplicate = target.applyChangeset(changeset);
const replaced = target.applyChangeset(changeset, { onConflict(type) { assert.equal(type, constants.SQLITE_CHANGESET_CONFLICT); ++conflicts; return constants.SQLITE_CHANGESET_REPLACE; } });
let primary = false, closeGuard = false; const error = Error('callback primary');
try { target.applyChangeset(changeset, { filter() { try { target.close(); } catch (e) { closeGuard = e.code === 'ERR_INVALID_STATE'; } throw error; } }); }
catch (caught) { primary = caught === error; }
session.close(); let closedSession = false;
try { session.changeset(); } catch (e) { closedSession = e.code === 'ERR_INVALID_STATE'; }
session[Symbol.dispose](); const remaining = source.createSession(); source.limits.column = 3; source.close(); remaining[Symbol.dispose]();
let closedDatabase = false;
try { remaining.patchset(); } catch (e) { closedDatabase = e.code === 'ERR_INVALID_STATE'; }
source.open(); const reopened = source.limits.column;
assert.ok(first && !duplicate && replaced && filters === 1 && conflicts === 2 && resetLimit && primary && closeGuard && closedSession && closedDatabase && reopened === 3);
console.log(JSON.stringify({ changeset: Buffer.from(changeset).toString('hex'), patchset: Buffer.from(patchset).toString('hex'), first, duplicate, replaced, filters, conflicts, resetLimit, primary, closeGuard, closedSession, closedDatabase, reopened }));
source.close(); target.close();
