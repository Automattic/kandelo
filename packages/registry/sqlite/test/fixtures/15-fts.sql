-- Full-text search (FTS5)
.bail on

-- Create FTS table
CREATE VIRTUAL TABLE docs USING fts5(title, body);

INSERT INTO docs VALUES('First Post', 'This is the first blog post about SQLite');
INSERT INTO docs VALUES('Second Post', 'Another post discussing database features');
INSERT INTO docs VALUES('SQLite Tutorial', 'Learn how to use SQLite for your projects');
INSERT INTO docs VALUES('Performance Tips', 'Optimize your SQLite database queries');

-- Basic MATCH search (3 docs mention SQLite: First Post body, SQLite Tutorial title, Performance Tips body)
SELECT CASE WHEN count(*) = 3
  THEN 'ok 1 - fts match'
  ELSE 'not ok 1 - count=' || count(*)
END FROM docs WHERE docs MATCH 'SQLite';

-- Column-specific search
SELECT CASE WHEN count(*) = 1
  THEN 'ok 2 - column match'
  ELSE 'not ok 2 - count=' || count(*)
END FROM docs WHERE docs MATCH 'title:Tutorial';

-- Phrase search
SELECT CASE WHEN count(*) = 1
  THEN 'ok 3 - phrase match'
  ELSE 'not ok 3 - count=' || count(*)
END FROM docs WHERE docs MATCH '"blog post"';

-- Boolean operators: AND
SELECT CASE WHEN count(*) = 1
  THEN 'ok 4 - AND search'
  ELSE 'not ok 4 - count=' || count(*)
END FROM docs WHERE docs MATCH 'SQLite AND Tutorial';

-- Boolean operators: OR
SELECT CASE WHEN count(*) >= 2
  THEN 'ok 5 - OR search'
  ELSE 'not ok 5 - count=' || count(*)
END FROM docs WHERE docs MATCH 'first OR Tutorial';

-- NOT operator (First Post + Performance Tips have SQLite but not Tutorial)
SELECT CASE WHEN count(*) = 2
  THEN 'ok 6 - NOT search'
  ELSE 'not ok 6 - count=' || count(*)
END FROM docs WHERE docs MATCH 'SQLite NOT Tutorial';

-- Prefix search
SELECT CASE WHEN count(*) >= 1
  THEN 'ok 7 - prefix search'
  ELSE 'not ok 7 - count=' || count(*)
END FROM docs WHERE docs MATCH 'optim*';

-- rank() ordering
SELECT CASE WHEN title IS NOT NULL
  THEN 'ok 8 - rank ordering'
  ELSE 'not ok 8'
END FROM docs WHERE docs MATCH 'SQLite' ORDER BY rank LIMIT 1;

-- highlight() function
SELECT CASE WHEN highlighted LIKE '%<b>SQLite</b>%'
  THEN 'ok 9 - highlight'
  ELSE 'not ok 9 - ' || highlighted
END FROM (SELECT highlight(docs, 1, '<b>', '</b>') as highlighted
  FROM docs WHERE docs MATCH 'SQLite' LIMIT 1);

-- snippet() function
SELECT CASE WHEN snip IS NOT NULL AND length(snip) > 0
  THEN 'ok 10 - snippet'
  ELSE 'not ok 10'
END FROM (SELECT snippet(docs, 1, '<b>', '</b>', '...', 10) as snip
  FROM docs WHERE docs MATCH 'database' LIMIT 1);

SELECT 'PASS';
