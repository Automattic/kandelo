-- JSON functions (SQLite 3.38+)
.bail on

-- json()
SELECT CASE WHEN json('{"a":1,"b":"hello"}') = '{"a":1,"b":"hello"}'
  THEN 'ok 1 - json' ELSE 'not ok 1' END;

-- json_extract
SELECT CASE WHEN json_extract('{"a":1,"b":"hello"}', '$.b') = 'hello'
  THEN 'ok 2 - json_extract' ELSE 'not ok 2' END;

-- -> operator (json_extract alias, returns JSON)
SELECT CASE WHEN ('{"a":1}' -> '$.a') = '1'
  THEN 'ok 3 - arrow op' ELSE 'not ok 3' END;

-- ->> operator (returns text)
SELECT CASE WHEN ('{"a":1}' ->> '$.a') = 1
  THEN 'ok 4 - double arrow' ELSE 'not ok 4' END;

-- json_array
SELECT CASE WHEN json_array(1, 2, 'three') = '[1,2,"three"]'
  THEN 'ok 5 - json_array' ELSE 'not ok 5' END;

-- json_object
SELECT CASE WHEN json_object('key', 'value') = '{"key":"value"}'
  THEN 'ok 6 - json_object' ELSE 'not ok 6' END;

-- json_type
SELECT CASE WHEN json_type('{"a":1}', '$.a') = 'integer'
  THEN 'ok 7 - json_type' ELSE 'not ok 7' END;

-- json_array_length
SELECT CASE WHEN json_array_length('[1,2,3,4,5]') = 5
  THEN 'ok 8 - json_array_length' ELSE 'not ok 8' END;

-- json_insert
SELECT CASE WHEN json_insert('{"a":1}', '$.b', 2) = '{"a":1,"b":2}'
  THEN 'ok 9 - json_insert' ELSE 'not ok 9' END;

-- json_replace
SELECT CASE WHEN json_replace('{"a":1}', '$.a', 99) = '{"a":99}'
  THEN 'ok 10 - json_replace' ELSE 'not ok 10' END;

-- json_set (insert or replace)
SELECT CASE WHEN json_set('{"a":1}', '$.a', 2, '$.b', 3) = '{"a":2,"b":3}'
  THEN 'ok 11 - json_set' ELSE 'not ok 11' END;

-- json_remove
SELECT CASE WHEN json_remove('{"a":1,"b":2}', '$.a') = '{"b":2}'
  THEN 'ok 12 - json_remove' ELSE 'not ok 12' END;

-- json_each (table-valued function)
SELECT CASE WHEN cnt = 3
  THEN 'ok 13 - json_each'
  ELSE 'not ok 13 - cnt=' || cnt
END FROM (SELECT count(*) as cnt FROM json_each('[10,20,30]'));

-- Nested JSON
SELECT CASE WHEN json_extract('{"a":{"b":{"c":42}}}', '$.a.b.c') = 42
  THEN 'ok 14 - nested json' ELSE 'not ok 14' END;

-- json_valid
SELECT CASE WHEN json_valid('{"a":1}') = 1 AND json_valid('not json') = 0
  THEN 'ok 15 - json_valid' ELSE 'not ok 15' END;

SELECT 'PASS';
