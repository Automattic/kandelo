-- Date/time functions
.bail on

-- date()
SELECT CASE WHEN date('2024-03-15') = '2024-03-15'
  THEN 'ok 1 - date' ELSE 'not ok 1' END;

-- time()
SELECT CASE WHEN time('12:30:45') = '12:30:45'
  THEN 'ok 2 - time' ELSE 'not ok 2' END;

-- datetime()
SELECT CASE WHEN datetime('2024-03-15 12:30:45') = '2024-03-15 12:30:45'
  THEN 'ok 3 - datetime' ELSE 'not ok 3' END;

-- julianday()
SELECT CASE WHEN abs(julianday('2024-01-01') - 2460310.5) < 0.001
  THEN 'ok 4 - julianday' ELSE 'not ok 4' END;

-- strftime
SELECT CASE WHEN strftime('%Y', '2024-03-15') = '2024'
  AND strftime('%m', '2024-03-15') = '03'
  AND strftime('%d', '2024-03-15') = '15'
  THEN 'ok 5 - strftime' ELSE 'not ok 5' END;

-- Date arithmetic
SELECT CASE WHEN date('2024-01-31', '+1 month') = '2024-03-02'
  THEN 'ok 6 - date add month'
  ELSE 'not ok 6 - ' || date('2024-01-31', '+1 month')
END;

SELECT CASE WHEN date('2024-03-15', '-10 days') = '2024-03-05'
  THEN 'ok 7 - date subtract days' ELSE 'not ok 7' END;

-- Day of week (0=Sunday)
SELECT CASE WHEN CAST(strftime('%w', '2024-03-15') AS INTEGER) = 5
  THEN 'ok 8 - day of week (Friday)' ELSE 'not ok 8' END;

-- Unix timestamp
SELECT CASE WHEN strftime('%s', '1970-01-01 00:00:00') = '0'
  THEN 'ok 9 - unix epoch' ELSE 'not ok 9' END;

SELECT CASE WHEN datetime(0, 'unixepoch') = '1970-01-01 00:00:00'
  THEN 'ok 10 - from unixepoch' ELSE 'not ok 10' END;

-- current_timestamp is set
SELECT CASE WHEN current_timestamp IS NOT NULL AND length(current_timestamp) > 0
  THEN 'ok 11 - current_timestamp'
  ELSE 'not ok 11'
END;

SELECT 'PASS';
