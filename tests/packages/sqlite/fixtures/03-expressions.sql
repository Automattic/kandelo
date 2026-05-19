-- Expressions: arithmetic, string, comparison, logical, CASE, COALESCE
.bail on

-- Arithmetic
SELECT CASE WHEN 2+3 = 5 THEN 'ok 1' ELSE 'not ok 1' END;
SELECT CASE WHEN 10-3 = 7 THEN 'ok 2' ELSE 'not ok 2' END;
SELECT CASE WHEN 4*5 = 20 THEN 'ok 3' ELSE 'not ok 3' END;
SELECT CASE WHEN 7/2 = 3 THEN 'ok 4 - integer div' ELSE 'not ok 4' END;
SELECT CASE WHEN 7%3 = 1 THEN 'ok 5 - modulo' ELSE 'not ok 5' END;
SELECT CASE WHEN -(-5) = 5 THEN 'ok 6 - negation' ELSE 'not ok 6' END;

-- String operations
SELECT CASE WHEN length('hello') = 5 THEN 'ok 7 - length' ELSE 'not ok 7' END;
SELECT CASE WHEN 'hello' || ' ' || 'world' = 'hello world'
  THEN 'ok 8 - concat' ELSE 'not ok 8' END;
SELECT CASE WHEN upper('hello') = 'HELLO' THEN 'ok 9 - upper' ELSE 'not ok 9' END;
SELECT CASE WHEN lower('HELLO') = 'hello' THEN 'ok 10 - lower' ELSE 'not ok 10' END;
SELECT CASE WHEN substr('hello', 2, 3) = 'ell' THEN 'ok 11 - substr' ELSE 'not ok 11' END;
SELECT CASE WHEN trim('  hi  ') = 'hi' THEN 'ok 12 - trim' ELSE 'not ok 12' END;
SELECT CASE WHEN replace('hello', 'l', 'r') = 'herro'
  THEN 'ok 13 - replace' ELSE 'not ok 13' END;
SELECT CASE WHEN instr('hello world', 'world') = 7
  THEN 'ok 14 - instr' ELSE 'not ok 14' END;

-- Comparison
SELECT CASE WHEN 1 < 2 AND 2 > 1 AND 1 <= 1 AND 1 >= 1
  THEN 'ok 15 - comparison' ELSE 'not ok 15' END;
SELECT CASE WHEN 1 != 2 AND 1 = 1
  THEN 'ok 16 - equality' ELSE 'not ok 16' END;
SELECT CASE WHEN 'abc' BETWEEN 'aaa' AND 'bbb'
  THEN 'ok 17 - between' ELSE 'not ok 17' END;
SELECT CASE WHEN 3 IN (1,2,3,4) AND 5 NOT IN (1,2,3)
  THEN 'ok 18 - in/not in' ELSE 'not ok 18' END;

-- LIKE / GLOB
SELECT CASE WHEN 'hello' LIKE 'hel%' AND 'hello' LIKE 'h_llo'
  THEN 'ok 19 - like' ELSE 'not ok 19' END;

-- COALESCE / IFNULL
SELECT CASE WHEN coalesce(NULL, NULL, 42) = 42
  THEN 'ok 20 - coalesce' ELSE 'not ok 20' END;
SELECT CASE WHEN ifnull(NULL, 'default') = 'default'
  THEN 'ok 21 - ifnull' ELSE 'not ok 21' END;

-- CASE
SELECT CASE WHEN (CASE 2 WHEN 1 THEN 'one' WHEN 2 THEN 'two' ELSE 'other' END) = 'two'
  THEN 'ok 22 - case expr' ELSE 'not ok 22' END;

-- CAST
SELECT CASE WHEN CAST('42' AS INTEGER) = 42
  THEN 'ok 23 - cast' ELSE 'not ok 23' END;

SELECT 'PASS';
