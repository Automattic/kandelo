-- JOIN operations: INNER, LEFT, CROSS, self-join, subquery
.bail on

CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE orders(id INTEGER PRIMARY KEY, user_id INTEGER, product TEXT, amount REAL);

INSERT INTO users VALUES(1, 'Alice');
INSERT INTO users VALUES(2, 'Bob');
INSERT INTO users VALUES(3, 'Charlie');

INSERT INTO orders VALUES(1, 1, 'Widget', 9.99);
INSERT INTO orders VALUES(2, 1, 'Gadget', 19.99);
INSERT INTO orders VALUES(3, 2, 'Widget', 9.99);

-- INNER JOIN
SELECT CASE WHEN cnt = 3
  THEN 'ok 1 - inner join'
  ELSE 'not ok 1 - cnt=' || cnt
END FROM (SELECT count(*) as cnt FROM users u JOIN orders o ON u.id = o.user_id);

-- LEFT JOIN (Charlie has no orders)
SELECT CASE WHEN cnt = 4
  THEN 'ok 2 - left join'
  ELSE 'not ok 2 - cnt=' || cnt
END FROM (SELECT count(*) as cnt FROM users u LEFT JOIN orders o ON u.id = o.user_id);

-- LEFT JOIN with NULL check
SELECT CASE WHEN name = 'Charlie' AND product IS NULL
  THEN 'ok 3 - left join null'
  ELSE 'not ok 3'
END FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE o.id IS NULL;

-- CROSS JOIN
SELECT CASE WHEN cnt = 9
  THEN 'ok 4 - cross join'
  ELSE 'not ok 4 - cnt=' || cnt
END FROM (SELECT count(*) as cnt FROM users CROSS JOIN orders);

-- Self join
CREATE TABLE employees(id INTEGER PRIMARY KEY, name TEXT, manager_id INTEGER);
INSERT INTO employees VALUES(1, 'CEO', NULL);
INSERT INTO employees VALUES(2, 'VP', 1);
INSERT INTO employees VALUES(3, 'Dev', 2);

SELECT CASE WHEN mgr = 'VP'
  THEN 'ok 5 - self join'
  ELSE 'not ok 5 - mgr=' || COALESCE(mgr, 'NULL')
END FROM (SELECT e.name, m.name as mgr FROM employees e
  LEFT JOIN employees m ON e.manager_id = m.id WHERE e.name = 'Dev');

-- Subquery in WHERE
SELECT CASE WHEN name = 'Alice'
  THEN 'ok 6 - subquery where'
  ELSE 'not ok 6'
END FROM users WHERE id IN (SELECT user_id FROM orders GROUP BY user_id HAVING count(*) > 1);

-- Correlated subquery
SELECT CASE WHEN cnt = 2
  THEN 'ok 7 - correlated subquery'
  ELSE 'not ok 7 - cnt=' || cnt
END FROM (
  SELECT count(*) as cnt FROM users u WHERE EXISTS (
    SELECT 1 FROM orders o WHERE o.user_id = u.id
  )
);

-- NATURAL JOIN
CREATE TABLE t1(a INTEGER, b TEXT);
CREATE TABLE t2(a INTEGER, c TEXT);
INSERT INTO t1 VALUES(1, 'x');
INSERT INTO t2 VALUES(1, 'y');
SELECT CASE WHEN b = 'x' AND c = 'y'
  THEN 'ok 8 - natural join'
  ELSE 'not ok 8'
END FROM t1 NATURAL JOIN t2;

SELECT 'PASS';
