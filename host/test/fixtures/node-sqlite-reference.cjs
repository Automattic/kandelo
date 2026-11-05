'use strict';
const assert = require('node:assert/strict');
const { Database } = require('node:sqlite');
const db = new Database(':memory:');
const foreignKeys = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
let doubleQuoteDenied = false;
try { db.prepare('SELECT "missing"'); } catch (error) { doubleQuoteDenied = error.code === 'ERR_SQLITE_ERROR'; }
db.exec('PRAGMA writable_schema = ON');
const writableSchema = db.prepare('PRAGMA writable_schema').get().writable_schema;
db.exec('CREATE TABLE t(i INTEGER, x TEXT, b BLOB, f REAL)');
const info = db.prepare('INSERT INTO t VALUES(?1,:text,?3,?4)').run({ text: 'é\0z' }, 9007199254740993n, new Uint8Array([0, 255, 7]), 1.25);
const selected = db.prepare('SELECT i,x,b,f FROM t', { readBigInts: true });
const typed = selected.get();
assert.deepEqual(db.prepare('SELECT typeof(?),length(?)').get(new Uint8Array(), new Uint8Array()),
  Object.assign(Object.create(null), { 'typeof(?)': 'blob', 'length(?)': 0 }));
db.exec('BEGIN'); const inTransaction = db.isTransaction; db.exec('ROLLBACK'); const afterRollback = db.isTransaction;
db.exec("CREATE VIRTUAL TABLE fts USING fts5(content); INSERT INTO fts VALUES('searchable words')");
const fts = db.prepare("SELECT count(*) AS n FROM fts WHERE fts MATCH 'searchable'").get().n;
const math = db.prepare('SELECT acos(1) AS n').get().n;
db.close(); let invalidated = false;
try { selected.get(); } catch (error) { invalidated = error.code === 'ERR_INVALID_STATE'; }
assert.equal(invalidated, true);
db.open(); const reopenedTables = db.prepare('SELECT count(*) AS n FROM sqlite_master').get().n; db.close();
const failed = new Database(process.argv[2], { open: false, readOnly: true }); let failedOpenClosed = false;
try { failed.open(); } catch (error) { failedOpenClosed = error.code === 'ERR_SQLITE_ERROR' && !failed.isOpen; }
assert.equal(failedOpenClosed, true);
console.log(JSON.stringify({ version: process.versions.sqlite, foreignKeys, doubleQuoteDenied, writableSchema,
  integer: String(typed.i), textHex: Buffer.from(typed.x).toString('hex'), blobHex: Buffer.from(typed.b).toString('hex'), real: typed.f,
  changes: info.changes, rowid: info.lastInsertRowid, emptyBlob: true, inTransaction, afterRollback, fts, math,
  invalidated, reopenedTables, failedOpenClosed }));
