-- Basic SQL operations: CREATE, INSERT, SELECT, UPDATE, DELETE
.bail on

CREATE TABLE t1(id INTEGER PRIMARY KEY, name TEXT, value REAL);

INSERT INTO t1 VALUES(1, 'alpha', 1.5);
INSERT INTO t1 VALUES(2, 'beta', 2.5);
INSERT INTO t1 VALUES(3, 'gamma', 3.5);

-- Verify count
SELECT CASE WHEN (SELECT count(*) FROM t1) = 3
  THEN 'ok 1 - insert 3 rows'
  ELSE 'not ok 1 - wrong count: ' || (SELECT count(*) FROM t1)
END;

-- Verify SELECT
SELECT CASE WHEN name = 'beta'
  THEN 'ok 2 - select by id'
  ELSE 'not ok 2 - got: ' || name
END FROM t1 WHERE id = 2;

-- UPDATE
UPDATE t1 SET value = 99.9 WHERE id = 2;
SELECT CASE WHEN value = 99.9
  THEN 'ok 3 - update'
  ELSE 'not ok 3 - got: ' || value
END FROM t1 WHERE id = 2;

-- DELETE
DELETE FROM t1 WHERE id = 3;
SELECT CASE WHEN (SELECT count(*) FROM t1) = 2
  THEN 'ok 4 - delete'
  ELSE 'not ok 4 - count: ' || (SELECT count(*) FROM t1)
END;

-- NULL handling
INSERT INTO t1 VALUES(4, NULL, NULL);
SELECT CASE WHEN name IS NULL AND value IS NULL
  THEN 'ok 5 - null insert'
  ELSE 'not ok 5 - not null'
END FROM t1 WHERE id = 4;

SELECT 'PASS';
