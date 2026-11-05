DROP TABLE IF EXISTS sink_value;
DROP TABLE IF EXISTS sink_value_status;
CREATE TABLE sink_value (
  caller INTEGER,callee INTEGER,parameter INTEGER,kind INTEGER,payload INTEGER,
  PRIMARY KEY(callee,parameter,caller,kind,payload)
) WITHOUT ROWID;
CREATE INDEX sink_value_caller ON sink_value(caller);
CREATE TABLE sink_value_status (function INTEGER PRIMARY KEY,unsupported INTEGER NOT NULL);
