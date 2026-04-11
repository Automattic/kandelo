-- Type system: INTEGER, REAL, TEXT, BLOB, type affinity
.bail on

CREATE TABLE types(
  i INTEGER,
  r REAL,
  t TEXT,
  b BLOB,
  n NUMERIC
);

INSERT INTO types VALUES(42, 3.14, 'hello', X'DEADBEEF', '123');

-- Integer
SELECT CASE WHEN typeof(i) = 'integer' AND i = 42
  THEN 'ok 1 - integer type'
  ELSE 'not ok 1 - type=' || typeof(i) || ' val=' || i
END FROM types;

-- Real
SELECT CASE WHEN typeof(r) = 'real' AND abs(r - 3.14) < 0.001
  THEN 'ok 2 - real type'
  ELSE 'not ok 2 - type=' || typeof(r) || ' val=' || r
END FROM types;

-- Text
SELECT CASE WHEN typeof(t) = 'text' AND t = 'hello'
  THEN 'ok 3 - text type'
  ELSE 'not ok 3 - type=' || typeof(t) || ' val=' || t
END FROM types;

-- Blob
SELECT CASE WHEN typeof(b) = 'blob' AND hex(b) = 'DEADBEEF'
  THEN 'ok 4 - blob type'
  ELSE 'not ok 4 - type=' || typeof(b) || ' hex=' || hex(b)
END FROM types;

-- Numeric affinity (stored as integer when possible)
SELECT CASE WHEN typeof(n) = 'integer' AND n = 123
  THEN 'ok 5 - numeric affinity'
  ELSE 'not ok 5 - type=' || typeof(n) || ' val=' || n
END FROM types;

-- Large integers
SELECT CASE WHEN 9223372036854775807 = 9223372036854775807
  THEN 'ok 6 - int64 max'
  ELSE 'not ok 6'
END;

-- Type coercion
SELECT CASE WHEN '3' + 4 = 7
  THEN 'ok 7 - text to num coercion'
  ELSE 'not ok 7'
END;

SELECT 'PASS';
