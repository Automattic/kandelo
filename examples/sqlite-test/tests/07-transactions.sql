-- Transactions: BEGIN, COMMIT, ROLLBACK, SAVEPOINT
.bail on

CREATE TABLE accounts(id INTEGER PRIMARY KEY, balance REAL);
INSERT INTO accounts VALUES(1, 100.0);
INSERT INTO accounts VALUES(2, 200.0);

-- Basic transaction
BEGIN;
UPDATE accounts SET balance = balance - 50 WHERE id = 1;
UPDATE accounts SET balance = balance + 50 WHERE id = 2;
COMMIT;

SELECT CASE WHEN (SELECT balance FROM accounts WHERE id = 1) = 50.0
  AND (SELECT balance FROM accounts WHERE id = 2) = 250.0
  THEN 'ok 1 - commit'
  ELSE 'not ok 1'
END;

-- Rollback
BEGIN;
UPDATE accounts SET balance = 0 WHERE id = 1;
ROLLBACK;

SELECT CASE WHEN (SELECT balance FROM accounts WHERE id = 1) = 50.0
  THEN 'ok 2 - rollback'
  ELSE 'not ok 2 - balance=' || (SELECT balance FROM accounts WHERE id = 1)
END;

-- Savepoint
BEGIN;
UPDATE accounts SET balance = balance + 100 WHERE id = 1;
SAVEPOINT sp1;
UPDATE accounts SET balance = balance + 200 WHERE id = 1;
ROLLBACK TO sp1;
COMMIT;

SELECT CASE WHEN (SELECT balance FROM accounts WHERE id = 1) = 150.0
  THEN 'ok 3 - savepoint rollback'
  ELSE 'not ok 3 - balance=' || (SELECT balance FROM accounts WHERE id = 1)
END;

-- Nested savepoints
BEGIN;
SAVEPOINT sp_outer;
INSERT INTO accounts VALUES(3, 300.0);
SAVEPOINT sp_inner;
INSERT INTO accounts VALUES(4, 400.0);
ROLLBACK TO sp_inner;
RELEASE sp_outer;
COMMIT;

SELECT CASE WHEN (SELECT count(*) FROM accounts) = 3
  AND (SELECT balance FROM accounts WHERE id = 3) = 300.0
  THEN 'ok 4 - nested savepoints'
  ELSE 'not ok 4 - count=' || (SELECT count(*) FROM accounts)
END;

-- Autocommit (no explicit transaction)
INSERT INTO accounts VALUES(5, 500.0);
SELECT CASE WHEN (SELECT balance FROM accounts WHERE id = 5) = 500.0
  THEN 'ok 5 - autocommit'
  ELSE 'not ok 5'
END;

SELECT 'PASS';
