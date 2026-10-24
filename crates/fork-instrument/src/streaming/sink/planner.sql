DROP TABLE IF EXISTS sink_site;
DROP TABLE IF EXISTS sink_target;
DROP TABLE IF EXISTS sink_reaching;
DROP TABLE IF EXISTS sink_rdep;
CREATE TABLE sink_site(caller INTEGER,point INTEGER,instruction INTEGER,tail INTEGER,
  PRIMARY KEY(caller,point)) WITHOUT ROWID;
CREATE TABLE sink_target(caller INTEGER,point INTEGER,target INTEGER,
  PRIMARY KEY(caller,point,target)) WITHOUT ROWID;
CREATE INDEX sink_target_reverse ON sink_target(target,caller);
CREATE TABLE sink_reaching(function INTEGER PRIMARY KEY);
CREATE TABLE sink_rdep(callee INTEGER,caller INTEGER,PRIMARY KEY(callee,caller)) WITHOUT ROWID;
CREATE INDEX sink_rdep_forward ON sink_rdep(caller,callee);
