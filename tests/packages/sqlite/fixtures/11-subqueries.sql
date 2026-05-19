-- Subqueries: scalar, table, EXISTS, IN, ANY/ALL patterns, UNION, INTERSECT, EXCEPT
.bail on

CREATE TABLE t1(x INTEGER);
INSERT INTO t1 VALUES(1);
INSERT INTO t1 VALUES(2);
INSERT INTO t1 VALUES(3);
INSERT INTO t1 VALUES(4);
INSERT INTO t1 VALUES(5);

CREATE TABLE t2(y INTEGER);
INSERT INTO t2 VALUES(3);
INSERT INTO t2 VALUES(4);
INSERT INTO t2 VALUES(5);
INSERT INTO t2 VALUES(6);
INSERT INTO t2 VALUES(7);

-- UNION
SELECT CASE WHEN count(*) = 7
  THEN 'ok 1 - union'
  ELSE 'not ok 1 - ' || count(*)
END FROM (SELECT x FROM t1 UNION SELECT y FROM t2);

-- UNION ALL
SELECT CASE WHEN count(*) = 10
  THEN 'ok 2 - union all'
  ELSE 'not ok 2 - ' || count(*)
END FROM (SELECT x FROM t1 UNION ALL SELECT y FROM t2);

-- INTERSECT
SELECT CASE WHEN count(*) = 3
  THEN 'ok 3 - intersect'
  ELSE 'not ok 3 - ' || count(*)
END FROM (SELECT x FROM t1 INTERSECT SELECT y FROM t2);

-- EXCEPT
SELECT CASE WHEN count(*) = 2
  THEN 'ok 4 - except'
  ELSE 'not ok 4 - ' || count(*)
END FROM (SELECT x FROM t1 EXCEPT SELECT y FROM t2);

-- Scalar subquery
SELECT CASE WHEN (SELECT max(x) FROM t1) = 5
  THEN 'ok 5 - scalar subquery'
  ELSE 'not ok 5'
END;

-- IN subquery
SELECT CASE WHEN count(*) = 3
  THEN 'ok 6 - in subquery'
  ELSE 'not ok 6 - ' || count(*)
END FROM t1 WHERE x IN (SELECT y FROM t2);

-- NOT IN subquery
SELECT CASE WHEN count(*) = 2
  THEN 'ok 7 - not in subquery'
  ELSE 'not ok 7 - ' || count(*)
END FROM t1 WHERE x NOT IN (SELECT y FROM t2);

-- EXISTS
SELECT CASE WHEN EXISTS(SELECT 1 FROM t1 WHERE x = 3)
  THEN 'ok 8 - exists'
  ELSE 'not ok 8'
END;

-- NOT EXISTS
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM t1 WHERE x = 99)
  THEN 'ok 9 - not exists'
  ELSE 'not ok 9'
END;

-- Derived table
SELECT CASE WHEN total = 15
  THEN 'ok 10 - derived table'
  ELSE 'not ok 10 - total=' || total
END FROM (SELECT sum(x) as total FROM t1);

-- Multiple levels of nesting
SELECT CASE WHEN cnt = 2
  THEN 'ok 11 - nested subquery'
  ELSE 'not ok 11 - cnt=' || cnt
END FROM (
  SELECT count(*) as cnt FROM t1
  WHERE x > (SELECT avg(x) FROM t1)
);

SELECT 'PASS';
