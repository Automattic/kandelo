-- Triggers: BEFORE/AFTER INSERT/UPDATE/DELETE
.bail on

CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT, quantity INTEGER);
CREATE TABLE audit_log(action TEXT, item_id INTEGER, old_val TEXT, new_val TEXT, ts TEXT DEFAULT CURRENT_TIMESTAMP);

-- AFTER INSERT trigger
CREATE TRIGGER trg_insert AFTER INSERT ON items
BEGIN
  INSERT INTO audit_log(action, item_id, new_val) VALUES('INSERT', NEW.id, NEW.name);
END;

INSERT INTO items VALUES(1, 'Widget', 10);
INSERT INTO items VALUES(2, 'Gadget', 20);

SELECT CASE WHEN count(*) = 2
  THEN 'ok 1 - after insert trigger'
  ELSE 'not ok 1 - count=' || count(*)
END FROM audit_log WHERE action = 'INSERT';

-- AFTER UPDATE trigger
CREATE TRIGGER trg_update AFTER UPDATE ON items
BEGIN
  INSERT INTO audit_log(action, item_id, old_val, new_val)
  VALUES('UPDATE', OLD.id, OLD.name || ':' || OLD.quantity, NEW.name || ':' || NEW.quantity);
END;

UPDATE items SET quantity = 15 WHERE id = 1;

SELECT CASE WHEN old_val = 'Widget:10' AND new_val = 'Widget:15'
  THEN 'ok 2 - after update trigger'
  ELSE 'not ok 2 - old=' || COALESCE(old_val,'NULL') || ' new=' || COALESCE(new_val,'NULL')
END FROM audit_log WHERE action = 'UPDATE' AND item_id = 1;

-- BEFORE DELETE trigger
CREATE TRIGGER trg_delete BEFORE DELETE ON items
BEGIN
  INSERT INTO audit_log(action, item_id, old_val) VALUES('DELETE', OLD.id, OLD.name);
END;

DELETE FROM items WHERE id = 2;

SELECT CASE WHEN (SELECT count(*) FROM audit_log WHERE action = 'DELETE') = 1
  THEN 'ok 3 - before delete trigger'
  ELSE 'not ok 3'
END;

-- INSTEAD OF trigger on view
CREATE VIEW v_items AS SELECT * FROM items;
CREATE TRIGGER trg_view_insert INSTEAD OF INSERT ON v_items
BEGIN
  INSERT INTO items VALUES(NEW.id, upper(NEW.name), NEW.quantity);
END;

INSERT INTO v_items VALUES(3, 'doohickey', 30);
SELECT CASE WHEN name = 'DOOHICKEY'
  THEN 'ok 4 - instead of trigger'
  ELSE 'not ok 4 - name=' || name
END FROM items WHERE id = 3;

-- DROP TRIGGER
DROP TRIGGER trg_insert;
INSERT INTO items VALUES(4, 'Thingamajig', 40);
SELECT CASE WHEN (SELECT count(*) FROM audit_log WHERE item_id = 4) = 0
  THEN 'ok 5 - drop trigger'
  ELSE 'not ok 5'
END;

-- Verify total audit entries (5: 2 inserts + 1 view insert trigger + 1 update + 1 delete)
SELECT CASE WHEN count(*) = 5
  THEN 'ok 6 - audit log total'
  ELSE 'not ok 6 - count=' || count(*)
END FROM audit_log;

SELECT 'PASS';
