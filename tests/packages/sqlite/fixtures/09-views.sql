-- Views, CTEs, window functions
.bail on

CREATE TABLE sales(id INTEGER, region TEXT, amount REAL, date TEXT);
INSERT INTO sales VALUES(1, 'East', 100, '2024-01-15');
INSERT INTO sales VALUES(2, 'West', 200, '2024-01-20');
INSERT INTO sales VALUES(3, 'East', 150, '2024-02-10');
INSERT INTO sales VALUES(4, 'West', 300, '2024-02-15');
INSERT INTO sales VALUES(5, 'East', 120, '2024-03-05');

-- CREATE VIEW
CREATE VIEW v_region_totals AS
SELECT region, sum(amount) as total, count(*) as cnt
FROM sales GROUP BY region;

SELECT CASE WHEN total = 370 AND cnt = 3
  THEN 'ok 1 - view'
  ELSE 'not ok 1 - total=' || total || ' cnt=' || cnt
END FROM v_region_totals WHERE region = 'East';

-- CTE (WITH)
WITH monthly AS (
  SELECT substr(date, 1, 7) as month, sum(amount) as total
  FROM sales GROUP BY substr(date, 1, 7)
)
SELECT CASE WHEN count(*) = 3
  THEN 'ok 2 - CTE'
  ELSE 'not ok 2 - ' || count(*)
END FROM monthly;

-- Recursive CTE (generate series)
WITH RECURSIVE cnt(x) AS (
  VALUES(1)
  UNION ALL
  SELECT x+1 FROM cnt WHERE x < 10
)
SELECT CASE WHEN sum(x) = 55
  THEN 'ok 3 - recursive CTE'
  ELSE 'not ok 3 - sum=' || sum(x)
END FROM cnt;

-- Window function: ROW_NUMBER
SELECT CASE WHEN rn = 3
  THEN 'ok 4 - row_number'
  ELSE 'not ok 4 - rn=' || rn
END FROM (
  SELECT id, ROW_NUMBER() OVER (ORDER BY amount DESC) as rn
  FROM sales
) WHERE id = 3;

-- Window function: SUM OVER
SELECT CASE WHEN running_total = 870
  THEN 'ok 5 - running sum'
  ELSE 'not ok 5 - rt=' || running_total
END FROM (
  SELECT id, SUM(amount) OVER (ORDER BY id) as running_total
  FROM sales
) WHERE id = 5;

-- Window function: RANK
SELECT CASE WHEN rnk = 1
  THEN 'ok 6 - rank'
  ELSE 'not ok 6 - rnk=' || rnk
END FROM (
  SELECT region, total, RANK() OVER (ORDER BY total DESC) as rnk
  FROM v_region_totals
) WHERE region = 'West';

-- Window function: LAG/LEAD
SELECT CASE WHEN prev_amount IS NULL AND next_amount = 200
  THEN 'ok 7 - lag/lead'
  ELSE 'not ok 7'
END FROM (
  SELECT id, amount,
    LAG(amount) OVER (ORDER BY id) as prev_amount,
    LEAD(amount) OVER (ORDER BY id) as next_amount
  FROM sales
) WHERE id = 1;

-- DROP VIEW
DROP VIEW v_region_totals;
SELECT CASE WHEN count(*) = 0
  THEN 'ok 8 - drop view'
  ELSE 'not ok 8'
END FROM sqlite_master WHERE name = 'v_region_totals';

SELECT 'PASS';
