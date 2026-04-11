-- Constraints: PRIMARY KEY, UNIQUE, NOT NULL, CHECK, FOREIGN KEY, DEFAULT
.bail on

-- PRIMARY KEY autoincrement
CREATE TABLE t1(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
INSERT INTO t1(name) VALUES('a');
INSERT INTO t1(name) VALUES('b');
INSERT INTO t1(name) VALUES('c');
SELECT CASE WHEN id = 3 THEN 'ok 1 - autoincrement' ELSE 'not ok 1 - id=' || id END
FROM t1 WHERE name = 'c';

-- NOT NULL
CREATE TABLE t2(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO t2 VALUES(1, 'valid');
-- This should fail:
INSERT OR IGNORE INTO t2 VALUES(2, NULL);
SELECT CASE WHEN count(*) = 1
  THEN 'ok 2 - not null'
  ELSE 'not ok 2 - count=' || count(*)
END FROM t2;

-- UNIQUE constraint
CREATE TABLE t3(id INTEGER PRIMARY KEY, email TEXT UNIQUE);
INSERT INTO t3 VALUES(1, 'a@b.com');
INSERT OR IGNORE INTO t3 VALUES(2, 'a@b.com');
SELECT CASE WHEN count(*) = 1
  THEN 'ok 3 - unique constraint'
  ELSE 'not ok 3 - count=' || count(*)
END FROM t3;

-- CHECK constraint
CREATE TABLE t4(id INTEGER PRIMARY KEY, age INTEGER CHECK(age >= 0 AND age <= 150));
INSERT INTO t4 VALUES(1, 25);
INSERT OR IGNORE INTO t4 VALUES(2, -1);
INSERT OR IGNORE INTO t4 VALUES(3, 200);
SELECT CASE WHEN count(*) = 1
  THEN 'ok 4 - check constraint'
  ELSE 'not ok 4 - count=' || count(*)
END FROM t4;

-- DEFAULT values
CREATE TABLE t5(id INTEGER PRIMARY KEY, status TEXT DEFAULT 'pending', created TEXT DEFAULT CURRENT_TIMESTAMP);
INSERT INTO t5(id) VALUES(1);
SELECT CASE WHEN status = 'pending' AND created IS NOT NULL
  THEN 'ok 5 - default values'
  ELSE 'not ok 5 - status=' || COALESCE(status, 'NULL')
END FROM t5;

-- FOREIGN KEY (pragma must be on)
PRAGMA foreign_keys = ON;
CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
INSERT INTO parent VALUES(1, 'p1');
INSERT INTO child VALUES(1, 1);
-- Verify FK: valid insert works
SELECT CASE WHEN count(*) = 1
  THEN 'ok 6 - foreign key (valid insert)'
  ELSE 'not ok 6 - count=' || count(*)
END FROM child;
-- Verify FK constraint exists by checking pragma
SELECT CASE WHEN count(*) > 0
  THEN 'ok 6b - foreign key pragma'
  ELSE 'not ok 6b'
END FROM pragma_foreign_key_list('child');

-- ON CONFLICT REPLACE
CREATE TABLE t6(id INTEGER PRIMARY KEY, val TEXT);
INSERT INTO t6 VALUES(1, 'old');
INSERT OR REPLACE INTO t6 VALUES(1, 'new');
SELECT CASE WHEN val = 'new' AND (SELECT count(*) FROM t6) = 1
  THEN 'ok 7 - on conflict replace'
  ELSE 'not ok 7'
END FROM t6 WHERE id = 1;

SELECT 'PASS';
