-- Schema operations: ALTER TABLE, table_info, VACUUM, ANALYZE
.bail on

-- CREATE TABLE with various constraints
CREATE TABLE t1(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  age INTEGER DEFAULT 0,
  bio TEXT
);

-- table_info pragma
SELECT CASE WHEN count(*) = 5
  THEN 'ok 1 - table_info'
  ELSE 'not ok 1 - cols=' || count(*)
END FROM pragma_table_info('t1');

-- ALTER TABLE ADD COLUMN
ALTER TABLE t1 ADD COLUMN phone TEXT;
SELECT CASE WHEN count(*) = 6
  THEN 'ok 2 - add column'
  ELSE 'not ok 2 - cols=' || count(*)
END FROM pragma_table_info('t1');

-- ALTER TABLE RENAME
ALTER TABLE t1 RENAME TO users;
SELECT CASE WHEN count(*) = 1
  THEN 'ok 3 - rename table'
  ELSE 'not ok 3'
END FROM sqlite_master WHERE name = 'users';

-- ALTER TABLE RENAME COLUMN
ALTER TABLE users RENAME COLUMN bio TO biography;
SELECT CASE WHEN count(*) = 1
  THEN 'ok 4 - rename column'
  ELSE 'not ok 4'
END FROM pragma_table_info('users') WHERE name = 'biography';

-- INSERT data and verify
INSERT INTO users(id, name, email, age) VALUES(1, 'Alice', 'alice@test.com', 30);
INSERT INTO users(id, name, email, age) VALUES(2, 'Bob', 'bob@test.com', 25);

-- CREATE TABLE AS SELECT
CREATE TABLE users_backup AS SELECT * FROM users;
SELECT CASE WHEN count(*) = 2
  THEN 'ok 5 - create table as'
  ELSE 'not ok 5'
END FROM users_backup;

-- DROP TABLE
DROP TABLE users_backup;
SELECT CASE WHEN count(*) = 0
  THEN 'ok 6 - drop table'
  ELSE 'not ok 6'
END FROM sqlite_master WHERE name = 'users_backup';

-- VACUUM
VACUUM;
SELECT 'ok 7 - vacuum';

-- ANALYZE
ANALYZE;
SELECT 'ok 8 - analyze';

-- sqlite_master introspection
SELECT CASE WHEN type = 'table' AND sql LIKE '%users%'
  THEN 'ok 9 - sqlite_master'
  ELSE 'not ok 9'
END FROM sqlite_master WHERE name = 'users';

-- Table exists check
SELECT CASE WHEN count(*) = 1
  THEN 'ok 10 - table exists'
  ELSE 'not ok 10'
END FROM sqlite_master WHERE type = 'table' AND name = 'users';

SELECT 'PASS';
