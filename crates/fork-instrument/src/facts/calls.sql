CREATE TABLE IF NOT EXISTS wasm_function (
  id INTEGER PRIMARY KEY,name INTEGER,binding_name INTEGER,sig INTEGER,imported INTEGER,
  in_table INTEGER DEFAULT 0,nparams INTEGER,i64_params INTEGER,first_i32 INTEGER,last_i32 INTEGER,
  bound_count INTEGER DEFAULT 0,chosen_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS wasm_by_signature ON wasm_function(sig,in_table,id);
CREATE INDEX IF NOT EXISTS wasm_by_name ON wasm_function(name,id);
CREATE INDEX IF NOT EXISTS wasm_by_binding_name ON wasm_function(binding_name,imported,id);
CREATE TABLE IF NOT EXISTS wasm_direct (caller INTEGER,callee INTEGER,PRIMARY KEY(caller,callee)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS wasm_indirect (caller INTEGER,sig INTEGER,occurrences INTEGER,
  PRIMARY KEY(caller,sig)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS wasm_constant (caller INTEGER,value INTEGER,PRIMARY KEY(caller,value)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS wasm_slot (slot INTEGER PRIMARY KEY,target INTEGER) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS binding_group (chunk INTEGER,name INTEGER,remaining INTEGER,
  PRIMARY KEY(name,chunk)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS bound_definition (caller INTEGER,definition INTEGER,
  PRIMARY KEY(caller,definition)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS chosen_definition (caller INTEGER,definition INTEGER,
  PRIMARY KEY(caller,definition)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS definition_signature (definition INTEGER,sig INTEGER,occurrences INTEGER,
  PRIMARY KEY(definition,sig)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS definition_holes (definition INTEGER PRIMARY KEY,missing INTEGER) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS own_known (target INTEGER PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS own_cfi (target INTEGER,ty INTEGER,PRIMARY KEY(target,ty)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS own_cfi_type ON own_cfi(ty,target);
CREATE TABLE IF NOT EXISTS verified_dtors (caller INTEGER PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS extra_registered (registry INTEGER,name INTEGER,
  PRIMARY KEY(registry,name)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS inferred_unknown_registry (registry INTEGER PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS hub (caller INTEGER,definition INTEGER,site INTEGER,ty INTEGER,priority INTEGER,registry INTEGER,
  PRIMARY KEY(caller,definition,site,ty,priority,registry)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS call_group (caller INTEGER,sig INTEGER,PRIMARY KEY(caller,sig)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS call_target (caller INTEGER,sig INTEGER,target INTEGER,
  PRIMARY KEY(caller,sig,target)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS cleanup_caller (caller INTEGER PRIMARY KEY,name INTEGER) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS cleanup_handler (caller INTEGER,handler INTEGER,PRIMARY KEY(caller,handler)) WITHOUT ROWID;

DELETE FROM wasm_function; DELETE FROM wasm_direct; DELETE FROM wasm_indirect;
DELETE FROM wasm_constant; DELETE FROM wasm_slot; DELETE FROM binding_group;
DELETE FROM bound_definition; DELETE FROM chosen_definition;
DELETE FROM definition_signature; DELETE FROM definition_holes;
DELETE FROM own_known; DELETE FROM own_cfi; DELETE FROM verified_dtors;
DELETE FROM extra_registered; DELETE FROM inferred_unknown_registry; DELETE FROM hub;
DELETE FROM call_group; DELETE FROM call_target; DELETE FROM cleanup_caller; DELETE FROM cleanup_handler;
