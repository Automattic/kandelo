DROP TABLE IF EXISTS sink_override_group;
DROP TABLE IF EXISTS sink_override_target;
DROP TABLE IF EXISTS sink_cleanup_group;
DROP TABLE IF EXISTS sink_cleanup_target;
CREATE TABLE sink_override_group(caller INTEGER,signature INTEGER,PRIMARY KEY(caller,signature)) WITHOUT ROWID;
CREATE TABLE sink_override_target(caller INTEGER,signature INTEGER,target INTEGER,PRIMARY KEY(caller,signature,target)) WITHOUT ROWID;
CREATE TABLE sink_cleanup_group(caller INTEGER PRIMARY KEY);
CREATE TABLE sink_cleanup_target(caller INTEGER,handler INTEGER,PRIMARY KEY(caller,handler)) WITHOUT ROWID;
