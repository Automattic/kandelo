DROP VIEW IF EXISTS sink_rdep;
DROP VIEW IF EXISTS sink_target;
DROP TABLE IF EXISTS sink_site;
DROP TABLE IF EXISTS sink_caller_group;
DROP TABLE IF EXISTS sink_target_member;
DROP TABLE IF EXISTS sink_target_group;
DROP TABLE IF EXISTS sink_reaching;
CREATE TABLE sink_site(caller INTEGER,point INTEGER,instruction INTEGER,tail INTEGER,group_id INTEGER,
  PRIMARY KEY(caller,point)) WITHOUT ROWID;
CREATE INDEX sink_site_group ON sink_site(group_id,caller);
CREATE TABLE sink_caller_group(caller INTEGER,group_id INTEGER,
  PRIMARY KEY(caller,group_id)) WITHOUT ROWID;
CREATE INDEX sink_caller_group_reverse ON sink_caller_group(group_id,caller);
CREATE TABLE sink_target_group(id INTEGER PRIMARY KEY,digest BLOB,size INTEGER);
CREATE INDEX sink_target_group_digest ON sink_target_group(digest,size);
CREATE TABLE sink_target_member(group_id INTEGER,target INTEGER,
  PRIMARY KEY(group_id,target)) WITHOUT ROWID;
CREATE INDEX sink_target_member_reverse ON sink_target_member(target,group_id);
CREATE VIEW sink_target AS SELECT s.caller,s.point,m.target
  FROM sink_site s JOIN sink_target_member m ON m.group_id=s.group_id;
CREATE TABLE sink_reaching(function INTEGER PRIMARY KEY);
CREATE VIEW sink_rdep AS SELECT m.target AS callee,s.caller
  FROM sink_caller_group s JOIN sink_target_member m ON m.group_id=s.group_id
  JOIN sink_reaching a ON a.function=m.target
  JOIN sink_reaching b ON b.function=s.caller;
