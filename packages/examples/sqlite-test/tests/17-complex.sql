-- Complex queries: multi-table, analytics, data manipulation patterns
.bail on

-- Create a small e-commerce schema
CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT, city TEXT);
CREATE TABLE products(id INTEGER PRIMARY KEY, name TEXT, price REAL, category TEXT);
CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INTEGER, order_date TEXT);
CREATE TABLE order_items(order_id INTEGER, product_id INTEGER, quantity INTEGER);

INSERT INTO customers VALUES(1, 'Alice', 'New York');
INSERT INTO customers VALUES(2, 'Bob', 'San Francisco');
INSERT INTO customers VALUES(3, 'Charlie', 'New York');
INSERT INTO customers VALUES(4, 'Diana', 'Chicago');

INSERT INTO products VALUES(1, 'Laptop', 999.99, 'Electronics');
INSERT INTO products VALUES(2, 'Mouse', 29.99, 'Electronics');
INSERT INTO products VALUES(3, 'Book', 19.99, 'Books');
INSERT INTO products VALUES(4, 'Headphones', 149.99, 'Electronics');
INSERT INTO products VALUES(5, 'Pen', 2.99, 'Office');

INSERT INTO orders VALUES(1, 1, '2024-01-15');
INSERT INTO orders VALUES(2, 1, '2024-02-20');
INSERT INTO orders VALUES(3, 2, '2024-01-25');
INSERT INTO orders VALUES(4, 3, '2024-03-10');
INSERT INTO orders VALUES(5, 4, '2024-03-15');

INSERT INTO order_items VALUES(1, 1, 1);
INSERT INTO order_items VALUES(1, 2, 2);
INSERT INTO order_items VALUES(2, 3, 3);
INSERT INTO order_items VALUES(3, 1, 1);
INSERT INTO order_items VALUES(3, 4, 1);
INSERT INTO order_items VALUES(4, 2, 5);
INSERT INTO order_items VALUES(5, 5, 10);

-- Multi-table join: customer spending
-- Alice: Widget*1=$999.99, Mouse*2=$59.98, Book*3=$59.97 = $1119.94
SELECT CASE WHEN abs(total - 1119.94) < 0.01
  THEN 'ok 1 - customer total spend'
  ELSE 'not ok 1 - total=' || total
END FROM (
  SELECT c.name, sum(p.price * oi.quantity) as total
  FROM customers c
  JOIN orders o ON c.id = o.customer_id
  JOIN order_items oi ON o.id = oi.order_id
  JOIN products p ON oi.product_id = p.id
  WHERE c.name = 'Alice'
  GROUP BY c.name
);

-- Top product by revenue
SELECT CASE WHEN name = 'Laptop'
  THEN 'ok 2 - top product'
  ELSE 'not ok 2 - name=' || name
END FROM (
  SELECT p.name, sum(p.price * oi.quantity) as revenue
  FROM products p
  JOIN order_items oi ON p.id = oi.product_id
  GROUP BY p.id
  ORDER BY revenue DESC
  LIMIT 1
);

-- City with most customers who ordered
SELECT CASE WHEN city = 'New York'
  THEN 'ok 3 - top city'
  ELSE 'not ok 3 - city=' || city
END FROM (
  SELECT c.city, count(DISTINCT c.id) as customer_count
  FROM customers c
  JOIN orders o ON c.id = o.customer_id
  GROUP BY c.city
  ORDER BY customer_count DESC
  LIMIT 1
);

-- Window function: running total per customer
WITH customer_orders AS (
  SELECT o.customer_id, o.order_date,
    sum(p.price * oi.quantity) as order_total,
    sum(sum(p.price * oi.quantity)) OVER (
      PARTITION BY o.customer_id ORDER BY o.order_date
    ) as running_total
  FROM orders o
  JOIN order_items oi ON o.id = oi.order_id
  JOIN products p ON oi.product_id = p.id
  GROUP BY o.id
)
SELECT CASE WHEN abs(running_total - 1119.94) < 0.01
  THEN 'ok 4 - running total'
  ELSE 'not ok 4 - rt=' || running_total
END FROM customer_orders
WHERE customer_id = 1
ORDER BY order_date DESC LIMIT 1;

-- Customers who never ordered (anti-join)
SELECT CASE WHEN count(*) = 0
  THEN 'ok 5 - all customers ordered'
  ELSE 'not ok 5 - ' || count(*) || ' never ordered'
END FROM customers c
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);

-- Category breakdown with percentage
WITH cat_revenue AS (
  SELECT p.category, sum(p.price * oi.quantity) as revenue
  FROM products p
  JOIN order_items oi ON p.id = oi.product_id
  GROUP BY p.category
),
total_rev AS (SELECT sum(revenue) as total FROM cat_revenue)
SELECT CASE WHEN pct > 50
  THEN 'ok 6 - electronics dominates'
  ELSE 'not ok 6 - pct=' || pct
END FROM (
  SELECT cr.category, round(cr.revenue * 100.0 / tr.total, 1) as pct
  FROM cat_revenue cr, total_rev tr
  WHERE cr.category = 'Electronics'
);

-- UPSERT pattern (INSERT OR REPLACE)
CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT);
INSERT INTO kv VALUES('theme', 'light');
INSERT OR REPLACE INTO kv VALUES('theme', 'dark');
SELECT CASE WHEN value = 'dark' AND (SELECT count(*) FROM kv) = 1
  THEN 'ok 7 - upsert'
  ELSE 'not ok 7'
END FROM kv WHERE key = 'theme';

-- Batch INSERT with VALUES
INSERT INTO kv VALUES('lang', 'en'), ('tz', 'UTC'), ('fmt', 'json');
SELECT CASE WHEN count(*) = 4
  THEN 'ok 8 - batch insert'
  ELSE 'not ok 8 - count=' || count(*)
END FROM kv;

-- UPDATE with subquery
UPDATE products SET price = price * 1.1
WHERE id IN (SELECT product_id FROM order_items GROUP BY product_id HAVING sum(quantity) > 2);
SELECT CASE WHEN abs(price - 32.989) < 0.01
  THEN 'ok 9 - update with subquery'
  ELSE 'not ok 9 - price=' || price
END FROM products WHERE id = 2;

-- DELETE with JOIN pattern (via subquery)
DELETE FROM order_items WHERE order_id IN (
  SELECT o.id FROM orders o WHERE o.order_date < '2024-02-01'
);
SELECT CASE WHEN count(*) = 3
  THEN 'ok 10 - delete with subquery'
  ELSE 'not ok 10 - count=' || count(*)
END FROM order_items;

SELECT 'PASS';
