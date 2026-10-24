-- Private disposable relations. Names are interned on disk, never copied into
-- per-edge Rust strings. Sparse call sites avoid attacker-sized Vec resizing.
CREATE TABLE atom (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  kind INTEGER NOT NULL DEFAULT 0, owner INTEGER, parameter INTEGER,
  target INTEGER, origin INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE unit (chunk INTEGER PRIMARY KEY, all_relaxed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE definition (
  id INTEGER PRIMARY KEY, chunk INTEGER NOT NULL, ordinal INTEGER NOT NULL,
  name INTEGER NOT NULL, binding_name INTEGER NOT NULL, module INTEGER NOT NULL, nparams INTEGER NOT NULL,
  site_count INTEGER NOT NULL DEFAULT 0, UNIQUE(chunk,ordinal)
);
CREATE INDEX definition_name ON definition(name);
CREATE INDEX definition_binding_name ON definition(binding_name,chunk);
CREATE TABLE site (
  definition INTEGER NOT NULL, ordinal INTEGER NOT NULL, direct INTEGER, sig INTEGER,
  untyped INTEGER NOT NULL DEFAULT 0, origin_kind INTEGER, origin_detail INTEGER,
  PRIMARY KEY(definition,ordinal)
) WITHOUT ROWID;
CREATE TABLE icall (definition INTEGER, site INTEGER, ty INTEGER,
  PRIMARY KEY(definition,site,ty)) WITHOUT ROWID;
CREATE TABLE vcall (definition INTEGER, site INTEGER, ty INTEGER, offset INTEGER,
  PRIMARY KEY(definition,site,ty,offset)) WITHOUT ROWID;
CREATE TABLE definition_type (definition INTEGER, ty INTEGER,
  PRIMARY KEY(definition,ty)) WITHOUT ROWID;
CREATE TABLE function_type (name INTEGER, ty INTEGER, PRIMARY KEY(name,ty)) WITHOUT ROWID;
CREATE TABLE cfi_type (ty INTEGER PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE vslot (name INTEGER, ty INTEGER, offset INTEGER,
  PRIMARY KEY(name,ty,offset)) WITHOUT ROWID;
CREATE TABLE registered (registry INTEGER, name INTEGER, PRIMARY KEY(registry,name)) WITHOUT ROWID;
CREATE TABLE registered_by (registry INTEGER, caller INTEGER, name INTEGER,
  PRIMARY KEY(registry,caller,name)) WITHOUT ROWID;
CREATE TABLE unknown_registry (registry INTEGER PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE old_action (name INTEGER PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE jmp (sequence INTEGER PRIMARY KEY, line TEXT NOT NULL UNIQUE);

-- kind: Q=1 W=2 Z=3 G=4 H=5 SE=6 SO=7 SF=8 SD=9 FT=10 NR=11.
-- a,b retain the oracle's logical direction (G is record -> function).
-- SO/SD retain per-unit relaxation, including AL appearing after the reads.
CREATE TABLE relation (
  kind INTEGER, a INTEGER, b INTEGER, chunk INTEGER DEFAULT 0, relaxed INTEGER DEFAULT 0,
  PRIMARY KEY(kind,a,b,chunk,relaxed)
) WITHOUT ROWID;
CREATE INDEX relation_reverse ON relation(kind,b,a);
CREATE TABLE slot_link (ty INTEGER, parameter INTEGER, name INTEGER,
  PRIMARY KEY(ty,parameter,name)) WITHOUT ROWID;
CREATE TABLE call_site (sequence INTEGER PRIMARY KEY, site INTEGER, callee INTEGER, caller INTEGER);
CREATE INDEX call_site_last ON call_site(site,sequence DESC);
CREATE TABLE argument (site INTEGER, parameter INTEGER, slot INTEGER,
  PRIMARY KEY(site,parameter,slot)) WITHOUT ROWID;

CREATE VIEW own_type AS SELECT a AS name,b AS ty FROM relation WHERE kind=1
  UNION SELECT name,ty FROM function_type;
CREATE VIEW cast_start AS SELECT a AS name,b AS ty FROM relation WHERE kind=2;
CREATE VIEW cast_edge AS SELECT a AS src,b AS dst FROM relation WHERE kind=3;
CREATE VIEW record_function AS SELECT a AS record,b AS name FROM relation WHERE kind=4;
CREATE VIEW record_pun AS SELECT a AS record,b AS ty FROM relation WHERE kind=5;
CREATE VIEW slot_edge AS SELECT a AS src,b AS dst FROM relation WHERE kind=6;
CREATE VIEW read_record AS SELECT a AS slot,b AS record,chunk,relaxed FROM relation WHERE kind=7;
CREATE VIEW read_function AS SELECT a AS slot,b AS ty FROM relation WHERE kind=8;
CREATE VIEW read_memory AS SELECT a AS slot,b AS ty,chunk,relaxed FROM relation WHERE kind=9;
CREATE VIEW record_type AS SELECT a AS record,b AS ty FROM relation WHERE kind=10;
CREATE VIEW record_nested AS SELECT a AS record,b AS nested FROM relation WHERE kind=11;
CREATE VIEW last_call_site AS SELECT c.site,c.callee,c.caller FROM call_site c
  WHERE c.sequence=(SELECT MAX(last.sequence) FROM call_site last WHERE last.site=c.site);
