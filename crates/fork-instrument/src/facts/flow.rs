//! External-memory port of targets.rs's conversion/slot-flow rules. Recursive
//! sets and graph edges live in the private database, not Rust HashSet graphs.

use super::storage::FactsStore;
use anyhow::{Context, Result, ensure};
use rusqlite::params;

impl FactsStore {
    /// Preserve the oracle's pass-through fixed point and its four slot/type
    /// feedback rounds. All intermediate relations remain file backed.
    pub fn solve_conversions(&self, effective_types: bool, slots: bool) -> Result<()> {
        let progress = crate::progress::Progress::new("conversion facts");
        self.conversions_ready.set(false);
        self.calls_ready.set(false);
        self.db.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            self.db.execute_batch(include_str!("flow.sql"))?;
            if slots {
                self.trace(&progress, "pass-through");
                self.pass_through()
                    .context("solving direct-call pass-through facts")?;
                self.trace(&progress, "records");
                self.records().context("solving nested record facts")?;
                self.trace(&progress, "link shapes");
                self.link_shapes().context("linking slot shapes")?;
            }
            self.trace(&progress, "conversion reach");
            self.conversions().context("solving conversion reach")?;
            if slots {
                for round in 0..4 {
                    progress.note(format_args!("feedback round {}", round + 1));
                    self.db.execute_batch(
                        "DELETE FROM old_conversion_reach; DELETE FROM old_conversion_name;
                        INSERT INTO old_conversion_reach SELECT * FROM conversion_reach;
                        INSERT INTO old_conversion_name SELECT * FROM conversion_name;",
                    )?;
                    self.trace(&progress, "slot origins");
                    self.origins().context("solving pointer slot origins")?;
                    self.trace(&progress, "read backs");
                    self.read_backs(effective_types)
                        .context("solving slot read backs")?;
                    self.trace(&progress, "conversion reach");
                    self.conversions()
                        .context("solving conversion reach feedback")?;
                    let changed: bool = self.db.query_row("SELECT
                        EXISTS(SELECT * FROM conversion_reach EXCEPT SELECT * FROM old_conversion_reach)
                        OR EXISTS(SELECT * FROM old_conversion_reach EXCEPT SELECT * FROM conversion_reach)
                        OR EXISTS(SELECT * FROM conversion_name EXCEPT SELECT * FROM old_conversion_name)
                        OR EXISTS(SELECT * FROM old_conversion_name EXCEPT SELECT * FROM conversion_name)", [], |r| r.get(0))?;
                    if !changed {
                        break;
                    }
                }
            }
            Ok(())
        })();
        if result.is_ok() {
            self.db.execute_batch("COMMIT")?;
            self.conversions_ready.set(true);
            self.trace(&progress, "complete");
        } else {
            self.trace(&progress, "failed");
            let _ = self.db.execute_batch("ROLLBACK");
        }
        result
    }

    /// Read one resolved pair at a time, in string order for deterministic
    /// diagnostics/differential tests. Native target queries use the indexed
    /// integer relation directly without collecting this output.
    pub fn visit_conversion_reach(
        &self,
        mut visit: impl FnMut(&str, &str) -> Result<()>,
    ) -> Result<()> {
        ensure!(
            self.conversions_ready.get(),
            "conversion planning has not completed"
        );
        let mut query = self.db.prepare(
            "SELECT n.name,t.name FROM conversion_reach r
            JOIN atom n ON n.id=r.name JOIN atom t ON t.id=r.ty ORDER BY n.name,t.name",
        )?;
        let mut rows = query.query([])?;
        while let Some(row) = rows.next()? {
            visit(row.get_ref(0)?.as_str()?, row.get_ref(1)?.as_str()?)?;
        }
        Ok(())
    }

    fn pass_through(&self) -> Result<()> {
        self.db.execute_batch(
            "INSERT INTO known_function SELECT DISTINCT l.name FROM slot_link l
            JOIN atom p ON p.id=l.parameter WHERE p.name='ret';",
        )?;
        let mut names = self.db.prepare(
            "SELECT name FROM known_function UNION SELECT callee FROM call_site ORDER BY name",
        )?;
        let mut rows = names.query([])?;
        while let Some(row) = rows.next()? {
            let name: i64 = row.get(0)?;
            let slot = self.atom(&format!("r:{}", self.name(name)?))?;
            self.execute("INSERT INTO return_slot VALUES(?,?)", params![name, slot])?;
        }
        loop {
            let mut changed = 0usize;
            // Match the oracle's deterministic lexicographic function order.
            let mut names = self.db.prepare(
                "SELECT k.name,r.slot FROM known_function k
                JOIN atom a ON a.id=k.name JOIN return_slot r ON r.name=k.name ORDER BY a.name",
            )?;
            let mut rows = names.query([])?;
            while let Some(row) = rows.next()? {
                let name: i64 = row.get(0)?;
                let slot: i64 = row.get(1)?;
                self.execute("DELETE FROM pass_walk", [])?;
                self.execute("WITH RECURSIVE walk(slot) AS (
                    SELECT src FROM slot_edge WHERE dst=?2
                    UNION
                    SELECT e.src FROM walk w JOIN atom a ON a.id=w.slot JOIN slot_edge e ON e.dst=w.slot
                      WHERE a.kind=2 AND a.owner=?1 AND NOT EXISTS(SELECT 1 FROM last_call_site c WHERE c.site=w.slot)
                    UNION
                    SELECT a.slot FROM walk w JOIN last_call_site c ON c.site=w.slot
                      JOIN argument a ON a.site=c.site WHERE c.caller=?1 AND (
                        NOT EXISTS(SELECT 1 FROM known_function k WHERE k.name=c.callee)
                        OR EXISTS(SELECT 1 FROM pass_parameter p WHERE p.name=c.callee AND p.parameter=a.parameter))
                  ) INSERT OR IGNORE INTO pass_walk SELECT slot FROM walk", params![name,slot])?;
                changed += self.execute(
                    "INSERT OR IGNORE INTO pass_parameter
                    SELECT ?1,a.parameter FROM pass_walk w JOIN atom a ON a.id=w.slot
                      WHERE a.kind=1 AND a.owner=?1 AND a.parameter IS NOT NULL
                        AND NOT EXISTS(SELECT 1 FROM last_call_site c WHERE c.site=w.slot)",
                    [name],
                )?;
                changed += self.execute("INSERT OR IGNORE INTO pass_other
                    SELECT ?1,w.slot FROM pass_walk w JOIN atom a ON a.id=w.slot
                      WHERE NOT (a.kind IN (1,2) AND a.owner=?1)
                        AND NOT EXISTS(SELECT 1 FROM last_call_site c WHERE c.site=w.slot)
                    UNION SELECT ?1,w.slot FROM pass_walk w JOIN last_call_site c ON c.site=w.slot WHERE c.caller<>?1
                    UNION SELECT ?1,o.slot FROM pass_walk w JOIN last_call_site c ON c.site=w.slot
                      JOIN pass_other o ON o.name=c.callee WHERE c.caller=?1
                        AND EXISTS(SELECT 1 FROM known_function k WHERE k.name=c.callee)
                    UNION SELECT ?1,r.slot FROM pass_walk w JOIN last_call_site c ON c.site=w.slot
                      JOIN return_slot r ON r.name=c.callee WHERE c.caller=?1
                        AND NOT EXISTS(SELECT 1 FROM known_function k WHERE k.name=c.callee)", [name])?;
            }
            if changed == 0 {
                break;
            }
        }
        self.db.execute_batch("INSERT OR IGNORE INTO pass_edge
            SELECT a.slot,c.site FROM call_site c JOIN argument a ON a.site=c.site
              WHERE NOT EXISTS(SELECT 1 FROM known_function k WHERE k.name=c.callee)
                OR EXISTS(SELECT 1 FROM pass_parameter p WHERE p.name=c.callee AND p.parameter=a.parameter)
            UNION SELECT p.slot,c.site FROM call_site c JOIN pass_other p ON p.name=c.callee
              WHERE EXISTS(SELECT 1 FROM known_function k WHERE k.name=c.callee)
            UNION SELECT r.slot,c.site FROM call_site c JOIN return_slot r ON r.name=c.callee
              WHERE NOT EXISTS(SELECT 1 FROM known_function k WHERE k.name=c.callee);")?;
        Ok(())
    }

    fn records(&self) -> Result<()> {
        self.db.execute_batch("WITH RECURSIVE nested(record,child) AS (
            SELECT record,record FROM record_function
            UNION SELECT record,record FROM record_type
            UNION SELECT record,record FROM record_nested
            UNION SELECT nested,nested FROM record_nested
            UNION SELECT record,record FROM read_record
            UNION SELECT target,target FROM atom WHERE kind=7
            UNION SELECT n.record,e.nested FROM nested n JOIN record_nested e ON e.record=n.child
          ) INSERT OR IGNORE INTO record_closure SELECT record,child FROM nested;
          INSERT OR IGNORE INTO record_functions SELECT c.record,f.name FROM record_closure c JOIN record_function f ON f.record=c.nested;
          INSERT OR IGNORE INTO record_types SELECT c.record,t.ty FROM record_closure c JOIN record_type t ON t.record=c.nested;")?;
        Ok(())
    }

    fn conversions(&self) -> Result<()> {
        self.db.execute_batch("DELETE FROM conversion_name; DELETE FROM conversion_reach;
            DELETE FROM conversion_edge; DELETE FROM conversion_seed;
            INSERT OR IGNORE INTO conversion_edge SELECT src,dst FROM cast_edge UNION SELECT src,dst FROM extra_cast;
            INSERT OR IGNORE INTO conversion_name
              SELECT name FROM cast_start UNION SELECT name FROM extra_start_name
              UNION SELECT f.name FROM record_function f JOIN record_pun p ON p.record=f.record
              UNION SELECT o.name FROM own_type o JOIN conversion_edge e ON e.src=o.ty
                JOIN atom a ON a.id=e.src WHERE a.name<>'*';
            INSERT OR IGNORE INTO conversion_seed
              SELECT name,ty FROM cast_start UNION SELECT name,ty FROM extra_start
              UNION SELECT f.name,p.ty FROM record_function f JOIN record_pun p ON p.record=f.record
              UNION SELECT o.name,o.ty FROM own_type o JOIN conversion_name n ON n.name=o.name;
            WITH RECURSIVE reach(name,ty) AS (
              SELECT name,ty FROM conversion_seed
              UNION SELECT r.name,e.dst FROM reach r JOIN conversion_edge e ON e.src=r.ty
            ) INSERT OR IGNORE INTO conversion_reach SELECT name,ty FROM reach;")?;
        Ok(())
    }

    fn link_shapes(&self) -> Result<()> {
        let mut query = self
            .db
            .prepare("SELECT ty,parameter,name FROM slot_link ORDER BY ty,parameter,name")?;
        let mut rows = query.query([])?;
        while let Some(row) = rows.next()? {
            let (ty, parameter, name): (i64, i64, i64) = (row.get(0)?, row.get(1)?, row.get(2)?);
            let (t, k, f) = (self.name(ty)?, self.name(parameter)?, self.name(name)?);
            let (src, dst) = if k == "ret" {
                (format!("r:{f}"), format!("rt:{t}"))
            } else {
                (format!("pt:{t}:{k}"), format!("p:{f}:{k}"))
            };
            self.execute(
                "INSERT INTO link_shape VALUES(?,?,?,?,?)",
                params![ty, parameter, name, self.atom(&src)?, self.atom(&dst)?],
            )?;
        }
        Ok(())
    }

    fn groups(&self) -> Result<()> {
        self.execute("DELETE FROM function_group", [])?;
        let mut names = self
            .db
            .prepare("SELECT DISTINCT name FROM conversion_reach ORDER BY name")?;
        let mut rows = names.query([])?;
        while let Some(row) = rows.next()? {
            let name: i64 = row.get(0)?;
            let mut types = self
                .db
                .prepare_cached("SELECT ty FROM conversion_reach WHERE name=? ORDER BY ty")?;
            let mut type_rows = types.query([name])?;
            let mut contents = Vec::new();
            while let Some(ty) = type_rows.next()? {
                ensure!(
                    contents.len() <= self.row_budget().saturating_sub(8),
                    "conversion reach set exceeds row budget"
                );
                let ty: i64 = ty.get(0)?;
                contents.extend_from_slice(&ty.to_le_bytes());
            }
            let created = self.execute(
                "INSERT OR IGNORE INTO reach_group(contents) VALUES(?)",
                [&contents],
            )?;
            let group: i64 = self
                .db
                .prepare_cached("SELECT id FROM reach_group WHERE contents=?")?
                .query_row([&contents], |r| r.get(0))?;
            if created != 0 {
                for ty in contents.chunks_exact(8) {
                    self.execute(
                        "INSERT INTO group_type VALUES(?,?)",
                        params![group, i64::from_le_bytes(ty.try_into().unwrap())],
                    )?;
                }
            }
            self.execute(
                "INSERT INTO function_group VALUES(?,?)",
                params![name, group],
            )?;
        }
        Ok(())
    }

    fn origins(&self) -> Result<()> {
        self.groups()?;
        self.db.execute_batch(
            "DELETE FROM flow_edge; DELETE FROM flow_origin;
            INSERT OR IGNORE INTO flow_edge SELECT src,dst FROM slot_edge
              UNION SELECT src,dst FROM pass_edge UNION SELECT src,dst FROM link_shape;",
        )?;
        let mut joins = self.db.prepare(
            "SELECT DISTINCT f.group_id,l.parameter FROM link_shape l
            JOIN function_group f ON f.name=l.name ORDER BY f.group_id,l.parameter",
        )?;
        let mut rows = joins.query([])?;
        while let Some(row) = rows.next()? {
            let (group, parameter): (i64, i64) = (row.get(0)?, row.get(1)?);
            let k = self.name(parameter)?;
            let slot = self.atom(&format!("#kandelo:join:{group}:{k}"))?;
            self.execute(
                "INSERT OR IGNORE INTO group_join VALUES(?,?,?)",
                params![group, parameter, slot],
            )?;
            let mut types = self
                .db
                .prepare_cached("SELECT ty FROM group_type WHERE group_id=? ORDER BY ty")?;
            let mut type_rows = types.query([group])?;
            while let Some(ty) = type_rows.next()? {
                let t = self.name(ty.get(0)?)?;
                let alias = self.atom(&if k == "ret" {
                    format!("rt:{t}")
                } else {
                    format!("pt:{t}:{k}")
                })?;
                let (src, dst) = if k == "ret" {
                    (slot, alias)
                } else {
                    (alias, slot)
                };
                self.execute(
                    "INSERT OR IGNORE INTO flow_edge VALUES(?,?)",
                    params![src, dst],
                )?;
            }
            if k == "ret" {
                self.execute(
                    "INSERT OR IGNORE INTO flow_edge SELECT l.src,?3 FROM link_shape l
                    JOIN function_group f ON f.name=l.name WHERE f.group_id=?1 AND l.parameter=?2",
                    params![group, parameter, slot],
                )?;
            } else {
                self.execute(
                    "INSERT OR IGNORE INTO flow_edge SELECT ?3,l.dst FROM link_shape l
                    JOIN function_group f ON f.name=l.name WHERE f.group_id=?1 AND l.parameter=?2",
                    params![group, parameter, slot],
                )?;
            }
        }
        self.db.execute_batch(
            "WITH RECURSIVE origins(slot,origin) AS (
            SELECT e.src,e.src FROM flow_edge e JOIN atom a ON a.id=e.src WHERE a.origin=1
            UNION SELECT e.dst,e.dst FROM flow_edge e JOIN atom a ON a.id=e.dst WHERE a.origin=1
            UNION SELECT e.dst,o.origin FROM origins o JOIN flow_edge e ON e.src=o.slot
          ) INSERT OR IGNORE INTO flow_origin SELECT slot,origin FROM origins;",
        )?;
        Ok(())
    }

    fn read_backs(&self, effective_types: bool) -> Result<()> {
        self.db.execute_batch(
            "DELETE FROM extra_start_name; DELETE FROM extra_start; DELETE FROM extra_cast;",
        )?;
        // A record read creates a start-name entry even when the destination
        // record has no function-typed fields. Its own types still seed reach.
        self.execute(
            "INSERT OR IGNORE INTO extra_start_name
            SELECT f.name FROM read_record r JOIN unit u ON u.chunk=r.chunk
              JOIN flow_origin o ON o.slot=r.slot JOIN atom a ON a.id=o.origin
              JOIN record_functions f ON f.record=a.target
            WHERE a.kind=7 AND a.target<>r.record AND (?1=0 OR r.relaxed OR u.all_relaxed)
            UNION SELECT a.target FROM read_function r JOIN flow_origin o ON o.slot=r.slot
              JOIN atom a ON a.id=o.origin WHERE a.kind=5
            UNION SELECT f.name FROM read_memory r JOIN unit u ON u.chunk=r.chunk
              JOIN flow_origin o ON o.slot=r.slot JOIN atom a ON a.id=o.origin
              JOIN record_functions f ON f.record=a.target
            WHERE a.kind=7 AND (?1=0 OR r.relaxed OR u.all_relaxed)",
            [effective_types],
        )?;
        self.execute(
            "INSERT OR IGNORE INTO extra_start
            SELECT f.name,t.ty FROM read_record r JOIN unit u ON u.chunk=r.chunk
              JOIN flow_origin o ON o.slot=r.slot JOIN atom a ON a.id=o.origin
              JOIN record_functions f ON f.record=a.target JOIN record_types t ON t.record=r.record
            WHERE a.kind=7 AND a.target<>r.record AND (?1=0 OR r.relaxed OR u.all_relaxed)
            UNION SELECT a.target,r.ty FROM read_function r JOIN flow_origin o ON o.slot=r.slot
              JOIN atom a ON a.id=o.origin WHERE a.kind=5
            UNION SELECT f.name,r.ty FROM read_memory r JOIN unit u ON u.chunk=r.chunk
              JOIN flow_origin o ON o.slot=r.slot JOIN atom a ON a.id=o.origin
              JOIN record_functions f ON f.record=a.target
            WHERE a.kind=7 AND (?1=0 OR r.relaxed OR u.all_relaxed)",
            [effective_types],
        )?;
        self.execute(
            "INSERT OR IGNORE INTO extra_cast
            SELECT a.target,r.ty FROM read_function r JOIN flow_origin o ON o.slot=r.slot
              JOIN atom a ON a.id=o.origin WHERE a.kind=6 AND a.target<>r.ty",
            [],
        )?;
        Ok(())
    }
}
