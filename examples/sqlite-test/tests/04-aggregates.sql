-- Aggregate functions and GROUP BY
.bail on

CREATE TABLE scores(name TEXT, subject TEXT, score INTEGER);
INSERT INTO scores VALUES('Alice', 'math', 90);
INSERT INTO scores VALUES('Alice', 'science', 85);
INSERT INTO scores VALUES('Bob', 'math', 80);
INSERT INTO scores VALUES('Bob', 'science', 95);
INSERT INTO scores VALUES('Charlie', 'math', 70);
INSERT INTO scores VALUES('Charlie', 'science', 75);

-- COUNT
SELECT CASE WHEN count(*) = 6
  THEN 'ok 1 - count(*)' ELSE 'not ok 1' END FROM scores;

-- SUM
SELECT CASE WHEN sum(score) = 495
  THEN 'ok 2 - sum' ELSE 'not ok 2 - ' || sum(score) END FROM scores;

-- AVG
SELECT CASE WHEN avg(score) = 82.5
  THEN 'ok 3 - avg' ELSE 'not ok 3 - ' || avg(score) END FROM scores;

-- MIN/MAX
SELECT CASE WHEN min(score) = 70 AND max(score) = 95
  THEN 'ok 4 - min/max' ELSE 'not ok 4' END FROM scores;

-- GROUP BY
SELECT CASE WHEN cnt = 2
  THEN 'ok 5 - group by count'
  ELSE 'not ok 5 - cnt=' || cnt
END FROM (SELECT name, count(*) as cnt FROM scores GROUP BY name LIMIT 1);

-- GROUP BY with HAVING
SELECT CASE WHEN (SELECT count(*) FROM
  (SELECT name, avg(score) as avg_s FROM scores GROUP BY name HAVING avg_s > 80)) = 2
  THEN 'ok 6 - having' ELSE 'not ok 6' END;

-- DISTINCT
SELECT CASE WHEN (SELECT count(DISTINCT name) FROM scores) = 3
  THEN 'ok 7 - count distinct' ELSE 'not ok 7' END;

-- GROUP_CONCAT
SELECT CASE WHEN group_concat(DISTINCT name) IN (
  'Alice,Bob,Charlie', 'Alice,Charlie,Bob', 'Bob,Alice,Charlie',
  'Bob,Charlie,Alice', 'Charlie,Alice,Bob', 'Charlie,Bob,Alice')
  THEN 'ok 8 - group_concat'
  ELSE 'not ok 8 - ' || group_concat(DISTINCT name)
END FROM scores;

-- total() returns 0.0 for empty set
SELECT CASE WHEN total(score) = 0.0
  THEN 'ok 9 - total empty'
  ELSE 'not ok 9'
END FROM scores WHERE 0;

SELECT 'PASS';
