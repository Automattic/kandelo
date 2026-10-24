//! Bound definition selection, registry policy and indirect targets over
//! file-backed relations. The oracle's expanded Side/Graph are never built.

use super::{FactsOptions, FactsReport, storage::FactsStore};
use crate::{sink::CallFacts, streaming::Scan};
use anyhow::{Context, Result, ensure};
use rusqlite::params;
use std::collections::HashMap;
use wasmparser::{Operator, Parser, Payload, ValType};

const PARAMS_AGREE: &str = "(w.nparams=d.nparams OR (w.nparams>d.nparams AND (
  2*(w.nparams-d.nparams)<=w.i64_params OR
  ((w.first_i32 OR w.last_i32) AND 2*(w.nparams-d.nparams-1)<=w.i64_params) OR
  (w.first_i32 AND w.last_i32 AND w.nparams-d.nparams>=2 AND 2*(w.nparams-d.nparams-2)<=w.i64_params))))";

impl FactsStore {
    pub fn resolve_calls(&self, scan: &Scan<'_>, options: FactsOptions) -> Result<FactsReport> {
        use sha2::{Digest, Sha256};
        let progress = crate::progress::Progress::new("call facts");
        self.calls_ready.set(false);
        let digest: [u8; 32] = Sha256::digest(scan.input()).into();
        ensure!(
            self.source_fingerprint == Some(digest),
            "call planning requires a store bound to this exact original module"
        );
        self.solve_conversions(options.effective_types, true)?;
        self.db.execute_batch("BEGIN IMMEDIATE")?;
        let result: Result<()> = (|| {
            self.db.execute_batch(include_str!("calls.sql"))?;
            self.trace(&progress, "Wasm inputs");
            self.wasm_inputs(scan)
                .context("collecting original Wasm call facts")?;
            self.trace(&progress, "bind definitions");
            self.bind_definitions()
                .context("binding compiler definitions")?;
            self.trace(&progress, "choose definitions");
            self.choose_definitions()
                .context("choosing compiler definitions")?;
            self.trace(&progress, "registries");
            self.registries().context("resolving callback registries")?;
            self.trace(&progress, "hubs");
            self.hubs().context("resolving callback dispatch hubs")?;
            self.trace(&progress, "targets");
            self.targets().context("resolving indirect call targets")?;
            self.trace(&progress, "complete");
            Ok(())
        })();
        if result.is_ok() {
            self.db.execute_batch("COMMIT")?;
            self.calls_ready.set(true);
        } else {
            self.trace(&progress, "failed");
            let _ = self.db.execute_batch("ROLLBACK");
        }
        result?;
        let count = |sql: &str| -> Result<usize> { Ok(self.db.query_row(sql, [], |r| r.get(0))?) };
        Ok(FactsReport {
            chunks: count("SELECT COUNT(*) FROM unit")?,
            definitions: count("SELECT COUNT(*) FROM definition")?,
            defined: count("SELECT COUNT(*) FROM wasm_function WHERE NOT imported")?,
            bound: count("SELECT COUNT(*) FROM wasm_function WHERE bound_count>0")?,
            bound_to_union: count("SELECT COUNT(*) FROM wasm_function WHERE bound_count>1")?,
            signature_mismatch: count(
                "SELECT COUNT(*) FROM wasm_function WHERE bound_count>0 AND chosen_count=0",
            )?,
        })
    }

    /// None means no facts group; Some(empty) is a proved empty target set.
    /// Only one group's target indices need to be resident in the sink pass.
    pub fn targets_for(&self, function: u32, signature: &str) -> Result<Option<Vec<u32>>> {
        ensure!(self.calls_ready.get(), "call planning has not completed");
        self.charge_work(3)?;
        let Some(sig) = self.find_atom(signature)? else {
            return Ok(None);
        };
        let exists: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM call_group WHERE caller=? AND sig=?)",
            params![function, sig],
            |r| r.get(0),
        )?;
        if !exists {
            return Ok(None);
        }
        let count: usize = self.db.query_row(
            "SELECT COUNT(*) FROM call_target WHERE caller=? AND sig=?",
            params![function, sig],
            |r| r.get(0),
        )?;
        ensure!(
            count <= self.metadata_budget() / 4,
            "facts target group exceeds resident metadata budget"
        );
        let mut output = Vec::with_capacity(count);
        let mut query = self.db.prepare_cached(
            "SELECT target FROM call_target WHERE caller=? AND sig=? ORDER BY target",
        )?;
        let mut rows = query.query(params![function, sig])?;
        while let Some(row) = rows.next()? {
            output.push(row.get(0)?);
        }
        Ok(Some(output))
    }

    /// Bounded compatibility projection for small fixtures/oracle comparison.
    /// The native planner uses disk lookups and need not collect this matrix.
    pub fn collect_call_facts(&self) -> Result<CallFacts> {
        ensure!(self.calls_ready.get(), "call planning has not completed");
        let mut remaining = self.metadata_budget();
        let mut output = CallFacts::default();
        let mut query = self.db.prepare("SELECT g.caller,a.name,g.sig FROM call_group g JOIN atom a ON a.id=g.sig ORDER BY g.caller,a.name")?;
        let mut rows = query.query([])?;
        while let Some(row) = rows.next()? {
            let caller = row.get(0)?;
            let sig = row.get_ref(1)?.as_str()?;
            let sig_id: i64 = row.get(2)?;
            let count: usize = self.db.query_row(
                "SELECT COUNT(*) FROM call_target WHERE caller=? AND sig=?",
                params![caller, sig_id],
                |r| r.get(0),
            )?;
            let charge = count
                .checked_mul(4)
                .and_then(|n| n.checked_add(sig.len() + 64))
                .context("facts target size overflow")?;
            ensure!(
                charge <= remaining,
                "facts projection exceeds resident metadata budget"
            );
            remaining -= charge;
            output.itargets.push((
                caller,
                sig.to_owned(),
                self.targets_for(caller, sig)?.unwrap(),
            ));
        }
        let mut query = self.db.prepare("SELECT c.caller,a.name FROM cleanup_caller c JOIN atom a ON a.id=c.name ORDER BY c.caller")?;
        let mut rows = query.query([])?;
        while let Some(row) = rows.next()? {
            let caller: u32 = row.get(0)?;
            let name = row.get_ref(1)?.as_str()?;
            charge(&mut remaining, name.len() + 64)?;
            let mut handlers = Vec::new();
            let mut query = self.db.prepare_cached("SELECT a.name FROM cleanup_handler h JOIN atom a ON a.id=h.handler WHERE h.caller=? ORDER BY a.name")?;
            let mut entries = query.query([caller])?;
            while let Some(row) = entries.next()? {
                let h = row.get_ref(0)?.as_str()?;
                charge(&mut remaining, h.len() + 32)?;
                handlers.push(h.to_owned());
            }
            output.cleanup.push((name.to_owned(), handlers));
        }
        let mut query = self.db.prepare("SELECT line FROM jmp ORDER BY sequence")?;
        let mut rows = query.query([])?;
        while let Some(row) = rows.next()? {
            let text = row.get_ref(0)?.as_str()?;
            charge(&mut remaining, text.len() + 32)?;
            output.jmp.push(text.to_owned());
        }
        Ok(output)
    }

    fn signature(&self, scan: &Scan<'_>, ty: u32, cache: &mut HashMap<u32, i64>) -> Result<i64> {
        if let Some(&id) = cache.get(&ty) {
            return Ok(id);
        }
        ensure!(
            cache.len() < self.metadata_budget() / 32,
            "facts signature catalog exceeds resident metadata budget"
        );
        let types = scan.types.as_ref();
        let function = types
            .get(types.core_type_at_in_module(ty))
            .unwrap()
            .composite_type
            .unwrap_func();
        let vt = |t: &ValType| match t {
            ValType::I32 => "i32",
            ValType::I64 => "i64",
            ValType::F32 => "f32",
            ValType::F64 => "f64",
            ValType::V128 => "v128",
            _ => "ref",
        };
        let text = format!(
            "{}->{}",
            function
                .params()
                .iter()
                .map(vt)
                .collect::<Vec<_>>()
                .join(","),
            function
                .results()
                .iter()
                .map(vt)
                .collect::<Vec<_>>()
                .join(",")
        );
        let id = self.atom(&text)?;
        cache.insert(ty, id);
        Ok(id)
    }

    fn wasm_inputs(&self, scan: &Scan<'_>) -> Result<()> {
        let mut signatures = HashMap::new();
        let types = scan.types.as_ref();
        for (index, f) in scan.functions.iter().enumerate() {
            let name = f.name.clone().unwrap_or_else(|| format!("#{index}"));
            let params = types
                .get(types.core_type_at_in_module(f.ty))
                .unwrap()
                .composite_type
                .unwrap_func()
                .params();
            self.execute("INSERT INTO wasm_function(id,name,binding_name,sig,imported,nparams,i64_params,first_i32,last_i32) VALUES(?,?,?,?,?,?,?,?,?)",
                params![index as u32,self.atom(&name)?,self.atom(f.name.as_deref().unwrap_or(""))?,self.signature(scan,f.ty,&mut signatures)?,f.import.is_some(),params.len(),
                    params.iter().filter(|&&v| v==ValType::I64).count(),params.first()==Some(&ValType::I32),params.last()==Some(&ValType::I32)])?;
        }
        super::targets::visit_retained_operators(
            scan,
            self.metadata_budget() / 4,
            |caller, op| {
                match *op {
                    Operator::Call { function_index } | Operator::ReturnCall { function_index } => {
                        self.execute(
                            "INSERT OR IGNORE INTO wasm_direct VALUES(?,?)",
                            params![caller as u32, function_index],
                        )?;
                    }
                    Operator::CallIndirect { type_index, .. }
                    | Operator::ReturnCallIndirect { type_index, .. } => {
                        self.execute("INSERT INTO wasm_indirect VALUES(?,?,1) ON CONFLICT(caller,sig) DO UPDATE SET occurrences=occurrences+1", params![caller as u32,self.signature(scan,type_index,&mut signatures)?])?;
                    }
                    Operator::I32Const { value }
                        if scan.functions[caller]
                            .name
                            .as_deref()
                            .is_some_and(|n| n.starts_with(".Lregister_call_dtors")) =>
                    {
                        self.execute(
                            "INSERT OR IGNORE INTO wasm_constant VALUES(?,?)",
                            params![caller as u32, value as i64],
                        )?;
                    }
                    _ => {}
                }
                Ok(())
            },
        )?;
        fn literal<'a>(e: wasmparser::ConstExpr<'a>) -> Result<Option<Operator<'a>>> {
            let mut reader = e.get_operators_reader();
            let first = reader.read()?;
            Ok(if matches!(reader.read()?, Operator::End) && reader.eof() {
                Some(first)
            } else {
                None
            })
        }
        for payload in Parser::new(0).parse_all(scan.input()) {
            let Payload::ElementSection(section) = payload? else {
                continue;
            };
            for e in section {
                let e = e?;
                let base = match &e.kind {
                    wasmparser::ElementKind::Active { offset_expr, .. } => {
                        match literal(offset_expr.clone())? {
                            Some(Operator::I32Const { value }) => Some(value as i64),
                            _ => None,
                        }
                    }
                    _ => None,
                };
                let declared = matches!(e.kind, wasmparser::ElementKind::Declared);
                match e.items {
                    wasmparser::ElementItems::Functions(items) => {
                        for (offset, f) in items.into_iter().enumerate() {
                            let f = f?;
                            if !declared {
                                self.execute(
                                    "UPDATE wasm_function SET in_table=1 WHERE id=?",
                                    [f],
                                )?;
                            }
                            if let Some(base) = base {
                                self.execute(
                                    "INSERT OR REPLACE INTO wasm_slot VALUES(?,?)",
                                    params![base + offset as i64, f],
                                )?;
                            }
                        }
                    }
                    wasmparser::ElementItems::Expressions(_, items) => {
                        for e in items {
                            if !declared
                                && let Some(Operator::RefFunc { function_index }) = literal(e?)?
                            {
                                self.execute(
                                    "UPDATE wasm_function SET in_table=1 WHERE id=?",
                                    [function_index],
                                )?;
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn bind_definitions(&self) -> Result<()> {
        self.db.execute_batch("INSERT INTO binding_group SELECT chunk,binding_name,COUNT(*) FROM definition GROUP BY chunk,binding_name;")?;
        let sql = "SELECT w.id,d.chunk FROM wasm_function w JOIN definition d ON d.binding_name=w.binding_name
            WHERE NOT w.imported AND (SELECT COUNT(*) FROM wasm_function x WHERE NOT x.imported AND x.binding_name=w.binding_name)=1
              AND (SELECT COUNT(*) FROM definition x WHERE x.binding_name=w.binding_name)=1 ORDER BY w.id";
        let mut query = self.db.prepare(sql)?;
        let mut rows = query.query([])?;
        let mut anchors: Vec<(u32, i64)> = Vec::new();
        while let Some(row) = rows.next()? {
            ensure!(
                anchors.len() < self.metadata_budget() / 128,
                "facts anchors exceed resident metadata budget"
            );
            anchors.push((row.get(0)?, row.get(1)?));
        }
        let mut tails: Vec<usize> = Vec::with_capacity(anchors.len());
        let mut previous = vec![None; anchors.len()];
        for (a, &(_, chunk)) in anchors.iter().enumerate() {
            let position = tails.partition_point(|&t| anchors[t].1 <= chunk);
            previous[a] = position.checked_sub(1).map(|i| tails[i]);
            if position == tails.len() {
                tails.push(a);
            } else {
                tails[position] = a;
            }
        }
        let mut chain = Vec::with_capacity(anchors.len());
        let mut current = tails.last().copied();
        while let Some(a) = current {
            chain.push(anchors[a]);
            current = previous[a];
        }
        chain.reverse();
        let mut next_anchor = chain.iter().peekable();
        let last_chunk: i64 = self
            .db
            .query_row("SELECT MAX(chunk) FROM unit", [], |r| r.get(0))?;
        let mut lo = 0;
        let candidate = format!("FROM binding_group g JOIN wasm_function w ON w.id=?1
            WHERE g.name=w.binding_name AND g.remaining>0 AND g.chunk BETWEEN ?2 AND ?3
              AND EXISTS(SELECT 1 FROM definition d WHERE d.binding_name=g.name AND d.chunk=g.chunk AND {PARAMS_AGREE})");
        let mut candidate_query = self.db.prepare(&format!(
            "SELECT g.chunk {candidate} ORDER BY g.chunk LIMIT 2"
        ))?;
        let insert = format!(
            "INSERT OR IGNORE INTO bound_definition SELECT w.id,d.id FROM definition d
            JOIN binding_group g ON g.name=d.binding_name AND g.chunk=d.chunk
            JOIN wasm_function w ON w.id=?1 WHERE d.binding_name=w.binding_name
              AND g.remaining>0 AND g.chunk BETWEEN ?2 AND ?3 AND {PARAMS_AGREE}"
        );
        let mut functions = self
            .db
            .prepare("SELECT id FROM wasm_function WHERE NOT imported ORDER BY id")?;
        let mut rows = functions.query([])?;
        while let Some(row) = rows.next()? {
            let function: u32 = row.get(0)?;
            while next_anchor.peek().is_some_and(|&&(id, _)| id < function) {
                next_anchor.next();
            }
            let hi = next_anchor.peek().map_or(last_chunk, |&&(_, chunk)| chunk);
            let mut candidates = candidate_query.query(params![function, lo, hi])?;
            let first = candidates.next()?.map(|r| r.get::<_, i64>(0)).transpose()?;
            let multiple = candidates.next()?.is_some();
            drop(candidates);
            if let Some(chunk) = first {
                self.execute(&insert, params![function, lo, hi])?;
                if !multiple {
                    self.execute("UPDATE binding_group SET remaining=remaining-1 WHERE chunk=? AND name=(SELECT binding_name FROM wasm_function WHERE id=?)",params![chunk,function])?;
                    lo = chunk;
                }
            }
        }
        self.db.execute_batch("UPDATE wasm_function SET bound_count=(SELECT COUNT(*) FROM bound_definition b WHERE b.caller=wasm_function.id);")?;
        Ok(())
    }

    fn choose_definitions(&self) -> Result<()> {
        self.db.execute_batch("INSERT INTO definition_signature
            SELECT definition,sig,COUNT(*) FROM site WHERE direct IS NULL AND sig IS NOT NULL GROUP BY definition,sig;
            INSERT INTO definition_holes SELECT d.id,d.site_count-COUNT(s.ordinal) FROM definition d LEFT JOIN site s ON s.definition=d.id GROUP BY d.id;
            UPDATE definition_holes SET missing=missing+(SELECT COUNT(*) FROM site s WHERE s.definition=definition_holes.definition AND s.direct IS NULL AND s.sig IS NULL);
            INSERT INTO chosen_definition SELECT b.caller,b.definition FROM bound_definition b
            WHERE (SELECT missing FROM definition_holes WHERE definition=b.definition)=0
              AND NOT EXISTS(SELECT sig,occurrences FROM definition_signature d WHERE d.definition=b.definition
                EXCEPT SELECT sig,occurrences FROM wasm_indirect w WHERE w.caller=b.caller)
              AND NOT EXISTS(SELECT sig,occurrences FROM wasm_indirect w WHERE w.caller=b.caller
                EXCEPT SELECT sig,occurrences FROM definition_signature d WHERE d.definition=b.definition);
            UPDATE wasm_function SET chosen_count=(SELECT COUNT(*) FROM chosen_definition c WHERE c.caller=wasm_function.id);
            INSERT INTO own_known SELECT DISTINCT caller FROM bound_definition;
            INSERT OR IGNORE INTO own_cfi SELECT b.caller,t.ty FROM bound_definition b JOIN definition_type t ON t.definition=b.definition;")?;
        if let Some(ty) = self.find_atom("_ZTSFvPvE")? {
            self.execute("INSERT OR IGNORE INTO own_known SELECT w.id FROM wasm_function w JOIN atom a ON a.id=w.name
                WHERE NOT w.imported AND w.bound_count=0 AND substr(a.name,1,length('.Lcall_dtors'))='.Lcall_dtors'
                  AND EXISTS(SELECT 1 FROM cfi_type WHERE ty=?1)",[ty])?;
            self.execute("INSERT OR IGNORE INTO own_cfi SELECT w.id,?1 FROM wasm_function w JOIN atom a ON a.id=w.name
                WHERE NOT w.imported AND w.bound_count=0 AND substr(a.name,1,length('.Lcall_dtors'))='.Lcall_dtors'
                  AND EXISTS(SELECT 1 FROM cfi_type WHERE ty=?1)",[ty])?;
        }
        Ok(())
    }

    fn registries(&self) -> Result<()> {
        self.db.execute_batch("INSERT INTO verified_dtors SELECT w.id FROM wasm_function w JOIN atom a ON a.id=w.name
            WHERE NOT w.imported AND w.bound_count=0 AND substr(a.name,1,length('.Lregister_call_dtors'))='.Lregister_call_dtors'
              AND NOT EXISTS(SELECT 1 FROM wasm_direct c JOIN wasm_function t ON t.id=c.callee JOIN atom n ON n.id=t.name WHERE c.caller=w.id AND n.name<>'__cxa_atexit')
              AND NOT EXISTS(SELECT 1 FROM wasm_constant c JOIN wasm_slot s ON s.slot=c.value JOIN wasm_function t ON t.id=s.target JOIN atom n ON n.id=t.name
                WHERE c.caller=w.id AND substr(n.name,1,length('.Lcall_dtors'))<>'.Lcall_dtors');")?;
        self.execute("INSERT OR IGNORE INTO extra_registered SELECT ?1,t.name FROM verified_dtors v
            JOIN wasm_constant c ON c.caller=v.caller JOIN wasm_slot s ON s.slot=c.value JOIN wasm_function t ON t.id=s.target",[self.atom("exit")?])?;
        for &(api, _, _, registry) in super::side::REG_APIS {
            let Some(api) = self.find_atom(api)? else {
                continue;
            };
            self.execute("INSERT OR IGNORE INTO inferred_unknown_registry SELECT ?1 WHERE
                EXISTS(SELECT 1 FROM wasm_direct c JOIN wasm_function w ON w.id=c.caller JOIN wasm_function t ON t.id=c.callee
                  WHERE NOT w.imported AND w.bound_count=0 AND t.name=?2 AND NOT EXISTS(SELECT 1 FROM verified_dtors v WHERE v.caller=w.id))
                OR EXISTS(SELECT 1 FROM wasm_function t WHERE t.name=?2 AND t.in_table)",params![self.atom(registry)?,api])?;
        }
        Ok(())
    }

    fn hubs(&self) -> Result<()> {
        for (priority, &(suffix, function, ty, registries)) in super::side::HUBS.iter().enumerate()
        {
            let Some(ty) = self.find_atom(ty)? else {
                continue;
            };
            for &registry in registries {
                self.execute("INSERT OR IGNORE INTO hub SELECT w.id,d.id,s.ordinal,?1,?2,?3
                    FROM wasm_function w JOIN atom n ON n.id=w.name JOIN chosen_definition c ON c.caller=w.id
                    JOIN definition d ON d.id=c.definition JOIN atom m ON m.id=d.module
                    JOIN site s ON s.definition=d.id JOIN icall i ON i.definition=s.definition AND i.site=s.ordinal
                    WHERE w.bound_count=1 AND w.chosen_count=1 AND (?4='*' OR n.name=?4)
                      AND substr(m.name,-length(?5))=?5 AND i.ty=?1 AND s.direct IS NULL AND s.sig IS NOT NULL",
                    params![ty,priority as i64,self.atom(registry)?,function,suffix])?;
            }
        }
        self.execute("WITH eligible AS MATERIALIZED (SELECT w.id AS caller,c.definition,s.ordinal AS site
            FROM wasm_function w JOIN chosen_definition c ON c.caller=w.id JOIN site s ON s.definition=c.definition
            JOIN atom k ON k.id=s.origin_kind JOIN old_action o ON o.name=s.origin_detail
            WHERE s.direct IS NULL AND s.sig IS NOT NULL AND k.name='global'
              AND NOT EXISTS(SELECT 1 FROM hub h WHERE h.caller=w.id AND h.definition=c.definition AND h.site=s.ordinal))
            INSERT OR IGNORE INTO hub SELECT e.caller,e.definition,e.site,i.ty,?1,?2 FROM eligible e
              JOIN icall i ON i.definition=e.definition AND i.site=e.site",
            params![super::side::HUBS.len() as i64,self.atom("signal")?])?;
        Ok(())
    }

    fn targets(&self) -> Result<()> {
        let cleanup = self.atom("_pthread_cleanup_pop")?;
        self.execute(
            "INSERT INTO call_group SELECT caller,sig FROM wasm_indirect",
            [],
        )?;
        self.execute(
            "INSERT INTO call_fallback
          SELECT g.caller,g.sig FROM call_group g JOIN wasm_function w ON w.id=g.caller
          WHERE NOT w.imported AND w.name<>?1 AND (w.chosen_count=0 OR EXISTS(
            SELECT 1 FROM chosen_definition c JOIN site s ON s.definition=c.definition
            WHERE c.caller=w.id AND s.direct IS NULL AND s.sig=g.sig AND s.untyped))",
            [cleanup],
        )?;
        self.execute(
            "INSERT INTO call_target_class
          SELECT t.sig,(EXISTS(SELECT 1 FROM own_known o WHERE o.target=t.id)
            OR EXISTS(SELECT 1 FROM vslot v WHERE v.name=t.name)),t.id
          FROM wasm_function t WHERE t.in_table",
            [],
        )?;
        self.execute(
            "INSERT INTO call_unknown_group
          SELECT g.caller,g.sig FROM call_group g JOIN wasm_function w ON w.id=g.caller
          WHERE NOT w.imported AND w.name<>?1
            AND NOT EXISTS(SELECT 1 FROM call_fallback f WHERE f.caller=g.caller AND f.sig=g.sig)
            AND EXISTS(SELECT 1 FROM chosen_definition c JOIN site s ON s.definition=c.definition
              WHERE c.caller=w.id AND s.direct IS NULL AND s.sig=g.sig)",
            [cleanup],
        )?;
        self.execute("INSERT OR IGNORE INTO call_refined_target
          SELECT g.caller,g.sig,t.id FROM call_group g JOIN wasm_function w ON w.id=g.caller
          JOIN call_target_class k ON k.sig=g.sig AND k.known=1
          JOIN wasm_function t ON t.id=k.target
          WHERE NOT EXISTS(SELECT 1 FROM call_fallback f WHERE f.caller=g.caller AND f.sig=g.sig)
          AND NOT w.imported AND w.name<>?1 AND (w.chosen_count=0 OR EXISTS(
            SELECT 1 FROM chosen_definition c JOIN site s ON s.definition=c.definition
            WHERE c.caller=w.id AND s.direct IS NULL AND s.sig=g.sig AND (
              s.untyped OR (
                NOT EXISTS(SELECT 1 FROM own_known o WHERE o.target=t.id)
                AND NOT EXISTS(SELECT 1 FROM vslot v WHERE v.name=t.name))
              OR (NOT EXISTS(SELECT 1 FROM hub h WHERE h.caller=w.id AND h.definition=s.definition AND h.site=s.ordinal)
                AND EXISTS(SELECT 1 FROM icall i JOIN conversion_reach r ON r.ty=i.ty AND r.name=t.name
                  WHERE i.definition=s.definition AND i.site=s.ordinal))
              OR EXISTS(SELECT 1 FROM icall i JOIN own_cfi o ON o.ty=i.ty AND o.target=t.id
                WHERE i.definition=s.definition AND i.site=s.ordinal AND (
                  NOT EXISTS(SELECT 1 FROM hub h WHERE h.caller=w.id AND h.definition=s.definition AND h.site=s.ordinal AND h.ty=i.ty)
                  OR EXISTS(SELECT 1 FROM hub h WHERE h.caller=w.id AND h.definition=s.definition AND h.site=s.ordinal AND h.ty=i.ty
                    AND h.priority=(SELECT MIN(hh.priority) FROM hub hh WHERE hh.caller=h.caller AND hh.definition=h.definition AND hh.site=h.site AND hh.ty=h.ty)
                    AND (EXISTS(SELECT 1 FROM unknown_registry u WHERE u.registry=h.registry)
                      OR EXISTS(SELECT 1 FROM inferred_unknown_registry u WHERE u.registry=h.registry)
                      OR EXISTS(SELECT 1 FROM registered r WHERE r.registry=h.registry AND r.name=t.name)
                      OR EXISTS(SELECT 1 FROM extra_registered r WHERE r.registry=h.registry AND r.name=t.name)))))
              OR EXISTS(SELECT 1 FROM vcall v JOIN vslot o ON o.ty=v.ty AND o.offset=v.offset AND o.name=t.name
                WHERE v.definition=s.definition AND v.site=s.ordinal)
            )))",[cleanup])?;
        self.execute("INSERT INTO cleanup_caller SELECT w.id,w.name FROM wasm_function w WHERE NOT w.imported AND w.chosen_count>0
            AND EXISTS(SELECT 1 FROM wasm_direct c JOIN wasm_function t ON t.id=c.callee WHERE c.caller=w.id AND t.name=?1)",[cleanup])?;
        self.execute(
            "INSERT OR IGNORE INTO cleanup_handler SELECT c.caller,r.name FROM cleanup_caller c
            JOIN registered_by r ON r.caller=c.name WHERE r.registry=?1",
            [self.atom("cleanup")?],
        )?;
        Ok(())
    }
}

fn charge(remaining: &mut usize, bytes: usize) -> Result<()> {
    ensure!(
        bytes <= *remaining,
        "facts projection exceeds resident metadata budget"
    );
    *remaining -= bytes;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facts::{
        bind::{self, Item},
        storage::StorageLimits,
    };

    #[test]
    fn external_binding_matches_anchor_windows_variants_and_parameter_lowering() {
        let item = |name, nparams| Item {
            name,
            nparams,
            ..Default::default()
        };
        let fixtures = [
            (
                vec![item("a", 1), item("c", 0)],
                vec![vec![item("a", 1), item("b", 2), item("c", 0)]],
            ),
            (
                vec![
                    item("__wasm_call_ctors", 0),
                    item("a", 1),
                    item("rust", 2),
                    item("b", 0),
                ],
                vec![vec![item("a", 1)], vec![item("b", 0)]],
            ),
            (
                vec![item("a", 0), item("cb", 1), item("b", 0)],
                vec![vec![item("a", 0), item("b", 0), item("cb", 1)]],
            ),
            (
                vec![
                    item("x", 0),
                    item("helper", 1),
                    item("y", 0),
                    item("helper", 2),
                    item("z", 0),
                ],
                vec![
                    vec![item("x", 0), item("helper", 1)],
                    vec![item("y", 0), item("helper", 2)],
                    vec![item("helper", 3), item("z", 0)],
                ],
            ),
            (
                vec![item("x", 0), item("helper", 1), item("z", 0)],
                vec![
                    vec![item("x", 0), item("helper", 1)],
                    vec![item("helper", 1), item("z", 0)],
                ],
            ),
            (
                vec![
                    item("a", 0),
                    item("C::~C()", 1),
                    item("C::~C()", 1),
                    item("b", 0),
                ],
                vec![vec![
                    item("a", 0),
                    item("C::~C()", 1),
                    item("b", 0),
                    item("C::~C()", 1),
                ]],
            ),
            (
                vec![item("late", 0), item("a", 0), item("b", 0), item("c", 0)],
                vec![
                    vec![item("a", 0)],
                    vec![item("b", 0)],
                    vec![item("c", 0)],
                    vec![item("late", 0)],
                ],
            ),
            (
                vec![item("main", 2)],
                vec![vec![item("__main_argc_argv", 2)]],
            ),
            (
                vec![
                    Item {
                        nparams: 3,
                        last_is_i32: true,
                        ..item("open", 0)
                    },
                    item("a", 0),
                ],
                vec![vec![item("open", 2), item("a", 0)]],
            ),
            (
                vec![Item {
                    nparams: 5,
                    i64_params: 4,
                    first_is_i32: true,
                    ..item("__addtf3", 0)
                }],
                vec![vec![item("__addtf3", 2)]],
            ),
            (
                vec![item("open", 1), item("a", 0)],
                vec![vec![item("open", 2), item("a", 0)]],
            ),
        ];
        for (module, chunks) in fixtures {
            let mut text = String::new();
            for chunk in &chunks {
                text.push_str("#kandelo-calltypes\t5\n");
                for d in chunk {
                    use std::fmt::Write;
                    writeln!(text, "F\t{}\t{}\nD\t{}\t0\t0", d.name, d.nparams, d.name).unwrap();
                }
            }
            let store =
                FactsStore::read_sections([text.as_bytes()], StorageLimits::default()).unwrap();
            store.db.execute_batch(include_str!("calls.sql")).unwrap();
            for (id, m) in module.iter().enumerate() {
                let name = store.atom(m.name).unwrap();
                store.execute("INSERT INTO wasm_function(id,name,binding_name,sig,imported,nparams,i64_params,first_i32,last_i32) VALUES(?,?,?,0,0,?,?,?,?)",
                    params![id as u32,name,name,m.nparams,m.i64_params,m.first_is_i32,m.last_is_i32]).unwrap();
            }
            store.bind_definitions().unwrap();
            let mut actual = vec![vec![]; module.len()];
            let mut query = store.db.prepare("SELECT b.caller,d.chunk,d.ordinal FROM bound_definition b JOIN definition d ON d.id=b.definition ORDER BY b.caller,d.chunk,d.ordinal").unwrap();
            let mut rows = query.query([]).unwrap();
            while let Some(row) = rows.next().unwrap() {
                actual[row.get::<_, usize>(0).unwrap()].push((
                    row.get::<_, usize>(1).unwrap(),
                    row.get::<_, usize>(2).unwrap(),
                ));
            }
            assert_eq!(actual, bind::bind(&module, &chunks), "{module:?}");
        }
    }
}
