-- Math functions (SQLite 3.35+) and other built-in functions
.bail on

-- Math functions
SELECT CASE WHEN abs(-42) = 42 THEN 'ok 1 - abs' ELSE 'not ok 1' END;
SELECT CASE WHEN max(1,2,3) = 3 THEN 'ok 2 - max' ELSE 'not ok 2' END;
SELECT CASE WHEN min(1,2,3) = 1 THEN 'ok 3 - min' ELSE 'not ok 3' END;

-- Random
SELECT CASE WHEN typeof(random()) = 'integer'
  THEN 'ok 4 - random' ELSE 'not ok 4' END;

-- zeroblob
SELECT CASE WHEN length(zeroblob(10)) = 10
  THEN 'ok 5 - zeroblob' ELSE 'not ok 5' END;

-- hex / unhex
SELECT CASE WHEN hex('ABC') = '414243'
  THEN 'ok 6 - hex' ELSE 'not ok 6 - ' || hex('ABC') END;

-- quote
SELECT CASE WHEN quote(42) = '42' AND quote(NULL) = 'NULL' AND quote('hi') = '''hi'''
  THEN 'ok 7 - quote' ELSE 'not ok 7' END;

-- unicode / char
SELECT CASE WHEN unicode('A') = 65 AND char(65) = 'A'
  THEN 'ok 8 - unicode/char' ELSE 'not ok 8' END;

-- printf / format
SELECT CASE WHEN printf('%05d', 42) = '00042'
  THEN 'ok 9 - printf' ELSE 'not ok 9 - ' || printf('%05d', 42) END;

-- typeof
SELECT CASE WHEN typeof(42) = 'integer'
  AND typeof(3.14) = 'real'
  AND typeof('hi') = 'text'
  AND typeof(NULL) = 'null'
  AND typeof(X'FF') = 'blob'
  THEN 'ok 10 - typeof' ELSE 'not ok 10' END;

-- GLOB
SELECT CASE WHEN 'hello' GLOB 'h*' AND 'hello' GLOB 'h?llo'
  THEN 'ok 11 - glob' ELSE 'not ok 11' END;

-- coalesce chain
SELECT CASE WHEN coalesce(NULL, NULL, NULL, 'found') = 'found'
  THEN 'ok 12 - coalesce chain' ELSE 'not ok 12' END;

-- nullif
SELECT CASE WHEN nullif(1, 1) IS NULL AND nullif(1, 2) = 1
  THEN 'ok 13 - nullif' ELSE 'not ok 13' END;

-- iif (SQLite 3.32+)
SELECT CASE WHEN iif(1 > 0, 'yes', 'no') = 'yes'
  THEN 'ok 14 - iif' ELSE 'not ok 14' END;

-- Aggregate: group_concat with separator
CREATE TABLE words(w TEXT);
INSERT INTO words VALUES('a');
INSERT INTO words VALUES('b');
INSERT INTO words VALUES('c');
SELECT CASE WHEN group_concat(w, '-') = 'a-b-c'
  THEN 'ok 15 - group_concat sep'
  ELSE 'not ok 15 - ' || group_concat(w, '-')
END FROM words;

SELECT 'PASS';
