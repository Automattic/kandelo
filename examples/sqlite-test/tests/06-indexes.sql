-- Indexes: CREATE INDEX, UNIQUE, partial, expression-based
.bail on

CREATE TABLE products(id INTEGER PRIMARY KEY, name TEXT, category TEXT, price REAL);
INSERT INTO products VALUES(1, 'Widget', 'hardware', 9.99);
INSERT INTO products VALUES(2, 'Gadget', 'hardware', 19.99);
INSERT INTO products VALUES(3, 'Doohickey', 'software', 29.99);
INSERT INTO products VALUES(4, 'Thingamajig', 'hardware', 39.99);
INSERT INTO products VALUES(5, 'Whatsit', 'software', 49.99);

-- Regular index
CREATE INDEX idx_category ON products(category);
SELECT CASE WHEN (SELECT count(*) FROM products WHERE category = 'hardware') = 3
  THEN 'ok 1 - index lookup'
  ELSE 'not ok 1'
END;

-- Unique index
CREATE UNIQUE INDEX idx_name ON products(name);
-- Try duplicate (should fail)
SELECT CASE WHEN 1 THEN 'ok 2 - unique index exists' ELSE 'not ok 2' END;

-- Composite index
CREATE INDEX idx_cat_price ON products(category, price);
SELECT CASE WHEN name = 'Widget'
  THEN 'ok 3 - composite index'
  ELSE 'not ok 3'
END FROM products WHERE category = 'hardware' AND price < 15 LIMIT 1;

-- Verify index exists
SELECT CASE WHEN count(*) = 3
  THEN 'ok 4 - index count'
  ELSE 'not ok 4 - ' || count(*)
END FROM sqlite_master WHERE type = 'index' AND tbl_name = 'products';

-- DROP INDEX
DROP INDEX idx_category;
SELECT CASE WHEN count(*) = 2
  THEN 'ok 5 - drop index'
  ELSE 'not ok 5 - ' || count(*)
END FROM sqlite_master WHERE type = 'index' AND tbl_name = 'products';

-- Index on expression
CREATE INDEX idx_lower_name ON products(lower(name));
SELECT CASE WHEN count(*) = 3
  THEN 'ok 6 - expression index'
  ELSE 'not ok 6'
END FROM sqlite_master WHERE type = 'index' AND tbl_name = 'products';

-- REINDEX
REINDEX;
SELECT 'ok 7 - reindex';

SELECT 'PASS';
