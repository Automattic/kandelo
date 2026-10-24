//! File-backed compiler facts for the native planner. SQLite owns indexed
//! integer relations and spill storage; no expanded Side graph is created.

use super::{
    definitions::{Definition, DefinitionIndex},
    stream::{self, Event, ReadLimits, ReadReport},
    target_cache::TargetCache,
};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, Params, limits::Limit, params};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

#[derive(Clone, Copy, Debug)]
pub struct StorageLimits {
    pub read: ReadLimits,
    /// SQLite page-cache target; not a hard process-memory ceiling. Query
    /// temporaries spill to files and an external physical guard is separate.
    pub page_cache_bytes: usize,
    pub atom_cache_bytes: usize,
    /// Optional shared signature-list cache. Eviction never rejects a group.
    pub target_cache_bytes: usize,
    pub metadata_bytes: usize,
    /// Maximum main database size, including derived fixed-point relations.
    pub disk_bytes: u64,
    /// SQLite virtual-machine instructions, checked in batches of 1,000.
    pub work_steps: u64,
}

impl Default for StorageLimits {
    fn default() -> Self {
        Self {
            read: ReadLimits::default(),
            page_cache_bytes: 32 * 1024 * 1024,
            atom_cache_bytes: 1024 * 1024,
            target_cache_bytes: 4 * 1024 * 1024,
            metadata_bytes: 128 * 1024 * 1024,
            disk_bytes: 8 * 1024 * 1024 * 1024,
            work_steps: crate::limits::SQL_WORK,
        }
    }
}

#[derive(Default)]
struct Cache {
    names: HashMap<String, (i64, bool)>,
    bytes: usize,
}

/// The connection is dropped before the private file, including on parse or
/// solver errors. No partially parsed store is returned to a caller.
pub struct FactsStore {
    pub(crate) db: Connection,
    _file: tempfile::NamedTempFile,
    cache: RefCell<Cache>,
    pub(super) target_cache: RefCell<TargetCache>,
    limits: StorageLimits,
    work: Arc<AtomicU64>,
    report: ReadReport,
    pub(crate) conversions_ready: Cell<bool>,
    pub(crate) calls_ready: Cell<bool>,
    pub(crate) source_fingerprint: Option<[u8; 32]>,
}

#[derive(Debug)]
pub struct StorageReport {
    pub chunks: usize,
    pub decoded_bytes: u64,
    pub atoms: u64,
    pub definitions: u64,
    pub relations: u64,
    pub database_bytes: u64,
    pub estimated_work_steps: u64,
}

impl FactsStore {
    /// Private bounded relation storage for native planning without compiler
    /// facts. No facts/call solution is marked ready by this constructor.
    pub fn empty(limits: StorageLimits) -> Result<Self> {
        Self::new(limits)
    }

    pub(crate) fn row_budget(&self) -> usize {
        self.limits.read.line_bytes
    }
    pub(crate) fn metadata_budget(&self) -> usize {
        self.limits.metadata_bytes
    }
    pub fn from_scan(scan: &crate::streaming::Scan<'_>, limits: StorageLimits) -> Result<Self> {
        scan.verify_facts_hash()?;
        use sha2::{Digest, Sha256};
        let mut store = Self::read_sections(scan.custom_data(super::SECTION), limits)?;
        store.source_fingerprint = Some(Sha256::digest(scan.input()).into());
        Ok(store)
    }

    pub fn read_sections<'a>(
        sections: impl IntoIterator<Item = &'a [u8]>,
        limits: StorageLimits,
    ) -> Result<Self> {
        let mut store = Self::new(limits)?;
        store.db.execute_batch("BEGIN IMMEDIATE")?;
        let mut state = ParseState::default();
        let report = stream::visit_lines(sections, limits.read, |event| {
            match event {
                Event::Begin { chunk } => {
                    store.execute("INSERT INTO unit(chunk) VALUES(?)", [chunk as i64])?;
                    state = ParseState {
                        chunk: chunk as i64,
                        module: store.atom("?")?,
                        ..Default::default()
                    };
                }
                Event::End { .. } => ensure!(
                    state.current.is_none(),
                    "facts chunk ends inside a function definition"
                ),
                Event::Line { number, text, .. } => store
                    .parse_line(&mut state, text)
                    .with_context(|| format!("facts chunk {}, line {number}", state.chunk))?,
            }
            Ok(())
        })?;
        store.db.execute_batch("COMMIT")?;
        store.report = report;
        Ok(store)
    }

    fn new(limits: StorageLimits) -> Result<Self> {
        ensure!(
            limits.page_cache_bytes >= 64 * 1024,
            "facts page cache budget is too small"
        );
        ensure!(limits.work_steps >= 1000, "facts work budget is too small");
        ensure!(
            limits.disk_bytes >= 4096 && limits.disk_bytes / 4096 <= u32::MAX as u64,
            "invalid facts disk budget"
        );
        let file = tempfile::NamedTempFile::new().context("creating private facts database")?;
        let db = Connection::open(file.path()).context("opening private facts database")?;
        db.set_prepared_statement_cache_capacity(64);
        // Large private relation transactions must spill dirty pages too;
        // keeping only clean query temporaries on disk is insufficient.
        db.pragma_update(None, "cache_spill", true)?;
        db.execute_batch("PRAGMA page_size=4096; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
            PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA threads=1; PRAGMA trusted_schema=OFF;")?;
        let cache_kib = i64::try_from(limits.page_cache_bytes / 1024)?;
        db.pragma_update(None, "cache_size", -cache_kib)?;
        db.pragma_update(Some("temp"), "cache_size", -cache_kib)?;
        let pages = limits.disk_bytes / 4096;
        db.pragma_update(None, "max_page_count", pages)?;
        ensure!(
            db.query_row("PRAGMA cache_size", [], |r| r.get::<_, i64>(0))? == -cache_kib,
            "facts page-cache setting was not applied"
        );
        ensure!(
            db.query_row("PRAGMA temp_store", [], |r| r.get::<_, u32>(0))? == 1,
            "facts temporaries must use file storage"
        );
        ensure!(
            db.query_row("PRAGMA cache_spill", [], |r| r.get::<_, u32>(0))? > 0,
            "native relation cache spilling must be enabled"
        );
        ensure!(
            !db.query_row(
                "SELECT sqlite_compileoption_used('TEMP_STORE=3')",
                [],
                |r| r.get::<_, bool>(0)
            )?,
            "this SQLite build forces query temporaries into memory"
        );
        ensure!(
            db.query_row("PRAGMA mmap_size", [], |r| r.get::<_, u64>(0))? == 0,
            "facts database must not map its whole file"
        );
        ensure!(
            db.query_row("PRAGMA max_page_count", [], |r| r.get::<_, u64>(0))? == pages,
            "facts disk budget was not applied"
        );
        let row_limit = limits
            .read
            .line_bytes
            .checked_mul(2)
            .and_then(|n| n.checked_add(1024))
            .context("facts row size overflow")?;
        let _ = db.set_limit(Limit::SQLITE_LIMIT_LENGTH, i32::try_from(row_limit)?)?;
        let work = Arc::new(AtomicU64::new(0));
        let counter = work.clone();
        let progress = crate::progress::Progress::new("storage");
        let mut reported = false;
        db.progress_handler(
            1000,
            Some(move || {
                let spent = counter
                    .fetch_add(1000, Ordering::Relaxed)
                    .saturating_add(1000);
                if spent > limits.work_steps {
                    if !reported {
                        progress.note(format_args!(
                            "work budget exhausted ({spent} units, limit {})",
                            limits.work_steps,
                        ));
                        reported = true;
                    }
                    true
                } else {
                    false
                }
            }),
        );
        db.execute_batch(include_str!("storage.sql"))
            .context("initializing bounded facts storage")?;
        Ok(Self {
            db,
            _file: file,
            cache: RefCell::default(),
            target_cache: RefCell::new(TargetCache::new(limits.target_cache_bytes)),
            limits,
            work,
            report: ReadReport::default(),
            conversions_ready: Cell::new(false),
            calls_ready: Cell::new(false),
            source_fingerprint: None,
        })
    }

    pub(crate) fn execute(&self, sql: &str, parameters: impl Params) -> Result<usize> {
        self.charge_work(1)?;
        Ok(self.db.prepare_cached(sql)?.execute(parameters)?)
    }

    /// Constant-size diagnostics: never scan relations merely to report progress.
    pub(crate) fn trace(&self, progress: &crate::progress::Progress, stage: &str) {
        if !progress.enabled() {
            return;
        }
        match self
            .db
            .pragma_query_value(None, "page_count", |r| r.get::<_, u64>(0))
        {
            Ok(pages) => progress.note(format_args!(
                "{stage}, {} database bytes, {} work units",
                pages.saturating_mul(4096),
                self.work.load(Ordering::Relaxed),
            )),
            Err(error) => progress.note(format_args!("{stage}, page count unavailable: {error}")),
        }
    }

    pub(crate) fn charge_work(&self, batches: u64) -> Result<()> {
        // Short statements may finish before SQLite invokes its progress
        // callback. Charge a full batch in addition to observed VM batches.
        let charge = batches
            .checked_mul(1000)
            .context("native storage work charge overflow")?;
        let spent = self
            .work
            .fetch_add(charge, Ordering::Relaxed)
            .saturating_add(charge);
        ensure!(
            spent <= self.limits.work_steps,
            "facts analysis exceeds work budget ({spent} units, limit {})",
            self.limits.work_steps,
        );
        Ok(())
    }

    pub(crate) fn atom(&self, name: &str) -> Result<i64> {
        ensure!(
            name.len() <= self.limits.read.line_bytes,
            "facts name exceeds line budget"
        );
        if let Some((id, true)) = self.cache.borrow().names.get(name).copied() {
            return Ok(id);
        }
        let id = self.raw_atom(name)?;
        // Derived owner/target strings are interned without recursively
        // classifying them. A hostile nested '@fn:' name must not recurse
        // through an input-controlled number of Rust stack frames.
        let (kind, owner, parameter, target) = if let Some(rest) = name.strip_prefix("@fn:") {
            (5, None, None, Some(self.raw_atom(rest)?))
        } else if let Some(rest) = name.strip_prefix("@ty:") {
            (6, None, None, Some(self.raw_atom(rest)?))
        } else if let Some(rest) = name.strip_prefix("@rec:") {
            (7, None, None, Some(self.raw_atom(rest)?))
        } else if let Some(rest) = name.strip_prefix("r:") {
            (3, Some(self.raw_atom(rest)?), None, None)
        } else if let Some(rest) = name.strip_prefix("p:").or_else(|| name.strip_prefix("l:")) {
            if let Some((owner, parameter)) = rest.rsplit_once(':') {
                (
                    if name.starts_with("p:") { 1 } else { 2 },
                    Some(self.raw_atom(owner)?),
                    parameter.parse::<u32>().ok(),
                    None,
                )
            } else {
                (0, None, None, None)
            }
        } else {
            (0, None, None, None)
        };
        self.execute(
            "UPDATE atom SET kind=?,owner=?,parameter=?,target=? WHERE id=?",
            params![kind, owner, parameter, target, id],
        )?;
        self.remember(name, id, true)?;
        Ok(id)
    }

    fn raw_atom(&self, name: &str) -> Result<i64> {
        if let Some((id, _)) = self.cache.borrow().names.get(name).copied() {
            return Ok(id);
        }
        let inserted = self.execute(
            "INSERT OR IGNORE INTO atom(name,origin) VALUES(?,?)",
            params![name, name.starts_with('@')],
        )?;
        let id = if inserted != 0 {
            self.db.last_insert_rowid()
        } else {
            self.db
                .prepare_cached("SELECT id FROM atom WHERE name=?")?
                .query_row([name], |r| r.get(0))?
        };
        self.remember(name, id, false)?;
        Ok(id)
    }

    fn remember(&self, name: &str, id: i64, classified: bool) -> Result<()> {
        let mut cache = self.cache.borrow_mut();
        if let Some(value) = cache.names.get_mut(name) {
            *value = (id, value.1 || classified);
            return Ok(());
        }
        let charge = name
            .len()
            .checked_add(64)
            .context("facts atom cache size overflow")?;
        if charge <= self.limits.atom_cache_bytes {
            if charge > self.limits.atom_cache_bytes.saturating_sub(cache.bytes) {
                cache.names.clear();
                cache.bytes = 0;
            }
            cache.names.insert(name.to_owned(), (id, classified));
            cache.bytes += charge;
        }
        Ok(())
    }

    pub(crate) fn find_atom(&self, name: &str) -> Result<Option<i64>> {
        self.charge_work(1)?;
        Ok(self
            .db
            .prepare_cached("SELECT id FROM atom WHERE name=?")?
            .query_row([name], |r| r.get(0))
            .optional()?)
    }

    pub(crate) fn name(&self, atom: i64) -> Result<String> {
        self.charge_work(1)?;
        Ok(self
            .db
            .prepare_cached("SELECT name FROM atom WHERE id=?")?
            .query_row([atom], |r| r.get(0))?)
    }

    pub fn report(&self) -> Result<StorageReport> {
        let count = |table: &str| -> Result<u64> {
            Ok(self
                .db
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?)
        };
        let pages: u64 = self.db.query_row("PRAGMA page_count", [], |r| r.get(0))?;
        Ok(StorageReport {
            chunks: self.report.chunks,
            decoded_bytes: self.report.decoded_bytes,
            atoms: count("atom")?,
            definitions: count("definition")?,
            relations: count("relation")?,
            database_bytes: pages * 4096,
            estimated_work_steps: self.work.load(Ordering::Relaxed),
        })
    }

    /// Existing linker-order binding metadata, with an independent resident
    /// budget. The large site/flow/cast graphs stay on disk throughout binding.
    pub fn definitions(&self) -> Result<DefinitionIndex> {
        let mut remaining = self.limits.metadata_bytes;
        let overhead = self
            .report
            .chunks
            .checked_mul(std::mem::size_of::<Vec<Definition>>())
            .context("facts definition metadata size overflow")?;
        ensure!(
            overhead <= remaining,
            "facts definitions exceed resident metadata budget"
        );
        remaining -= overhead;
        let mut out = DefinitionIndex {
            chunks: (0..self.report.chunks).map(|_| vec![]).collect(),
            decoded_bytes: self.report.decoded_bytes,
        };
        let mut query = self.db.prepare("SELECT d.chunk,a.name,d.nparams FROM definition d JOIN atom a ON a.id=d.name ORDER BY d.chunk,d.ordinal")?;
        let mut rows = query.query([])?;
        while let Some(row) = rows.next()? {
            let name = row.get_ref(1)?.as_str()?;
            let charge = name.len() + std::mem::size_of::<Definition>();
            ensure!(
                charge <= remaining,
                "facts definitions exceed resident metadata budget"
            );
            remaining -= charge;
            let chunk: usize = row.get(0)?;
            out.chunks[chunk].push(Definition {
                name: name.to_owned(),
                nparams: row.get(2)?,
            });
        }
        Ok(out)
    }

    fn site(&self, state: &ParseState, index: &str) -> Result<(i64, i64)> {
        let (definition, _) = state
            .current
            .as_ref()
            .context("site record outside a function")?;
        let index = number(index)?;
        let count = index.checked_add(1).context("facts site count overflow")?;
        self.execute(
            "INSERT OR IGNORE INTO site(definition,ordinal) VALUES(?,?)",
            params![definition, index],
        )?;
        self.execute(
            "UPDATE definition SET site_count=MAX(site_count,?) WHERE id=?",
            params![count, definition],
        )?;
        Ok((*definition, index))
    }

    fn parse_line(&self, state: &mut ParseState, text: &str) -> Result<()> {
        let fields: Vec<_> = text.split('\t').take(8).collect();
        let need = |n| -> Result<()> {
            ensure!(fields.len() >= n, "`{}` needs {n} fields", fields[0]);
            Ok(())
        };
        match fields[0] {
            "#kandelo-calltypes" => {}
            "M" => {
                need(2)?;
                state.module = self.atom(fields[1])?;
            }
            "F" => {
                need(3)?;
                ensure!(state.current.is_none(), "F inside a function");
                let name = self.atom(fields[1])?;
                let binding_name = self.atom(super::bind::module_name(fields[1]))?;
                self.execute("INSERT INTO definition(chunk,ordinal,name,binding_name,module,nparams) VALUES(?,?,?,?,?,?)", params![state.chunk,state.ordinal,name,binding_name,state.module,number(fields[2])?])?;
                state.current = Some((self.db.last_insert_rowid(), name));
            }
            "D" => {
                need(4)?;
                let (definition, name) = state.current.take().context("D outside a function")?;
                ensure!(
                    self.name(name)? == fields[1],
                    "definition end name mismatch"
                );
                self.execute(
                    "UPDATE definition SET site_count=MAX(site_count,?) WHERE id=?",
                    params![number(fields[3])?, definition],
                )?;
                state.ordinal += 1;
            }
            "C" => {
                need(4)?;
                let (definition, index) = self.site(state, fields[2])?;
                self.execute(
                    "UPDATE site SET direct=? WHERE definition=? AND ordinal=?",
                    params![self.atom(fields[3])?, definition, index],
                )?;
            }
            "Y" => {
                need(4)?;
                let (definition, index) = self.site(state, fields[2])?;
                self.execute("UPDATE site SET origin_kind=?,origin_detail=? WHERE definition=? AND ordinal=?", params![self.atom(fields[3])?,self.atom(fields.get(4).copied().unwrap_or(""))?,definition,index])?;
            }
            "S" => {
                need(5)?;
                let (definition, index) = self.site(state, fields[2])?;
                self.execute(
                    "UPDATE site SET sig=? WHERE definition=? AND ordinal=?",
                    params![self.atom(fields[3])?, definition, index],
                )?;
                match fields[4] {
                    "icall" => {
                        need(6)?;
                        let ty = self.atom(fields[5])?;
                        self.execute("INSERT OR IGNORE INTO cfi_type VALUES(?)", [ty])?;
                        self.execute(
                            "INSERT OR IGNORE INTO icall VALUES(?,?,?)",
                            params![definition, index, ty],
                        )?;
                    }
                    "vcall" => {
                        need(7)?;
                        let ty = self.atom(fields[5])?;
                        self.execute("INSERT OR IGNORE INTO cfi_type VALUES(?)", [ty])?;
                        self.execute(
                            "INSERT OR IGNORE INTO vcall VALUES(?,?,?,?)",
                            params![
                                definition,
                                index,
                                ty,
                                fields[6]
                                    .parse::<i64>()
                                    .context("bad virtual call offset")?
                            ],
                        )?;
                    }
                    _ => {
                        self.execute(
                            "UPDATE site SET untyped=1 WHERE definition=? AND ordinal=?",
                            params![definition, index],
                        )?;
                    }
                }
            }
            "T" => {
                need(3)?;
                let ty = self.atom(fields[2])?;
                self.execute("INSERT OR IGNORE INTO cfi_type VALUES(?)", [ty])?;
                self.execute(
                    "INSERT OR IGNORE INTO function_type VALUES(?,?)",
                    params![self.atom(fields[1])?, ty],
                )?;
                if let Some((definition, _)) = state.current {
                    self.execute(
                        "INSERT OR IGNORE INTO definition_type VALUES(?,?)",
                        params![definition, ty],
                    )?;
                }
            }
            "V" => {
                need(4)?;
                let ty = self.atom(fields[2])?;
                self.execute("INSERT OR IGNORE INTO cfi_type VALUES(?)", [ty])?;
                self.execute(
                    "INSERT OR IGNORE INTO vslot VALUES(?,?,?)",
                    params![
                        self.atom(fields[1])?,
                        ty,
                        fields[3]
                            .parse::<i64>()
                            .context("bad virtual slot offset")?
                    ],
                )?;
            }
            "O" => {
                need(2)?;
                self.execute(
                    "INSERT OR IGNORE INTO old_action VALUES(?)",
                    [self.atom(fields[1])?],
                )?;
            }
            "AL" => {
                state.relaxed = true;
                if text == "AL\trelaxed" {
                    self.execute("UPDATE unit SET all_relaxed=1 WHERE chunk=?", [state.chunk])?;
                }
            }
            "Q" | "W" | "Z" | "G" | "H" | "SE" | "SO" | "SF" | "SD" | "FT" | "NR" => {
                need(if fields[0] == "H" { 2 } else { 3 })?;
                let kind = match fields[0] {
                    "Q" => 1,
                    "W" => 2,
                    "Z" => 3,
                    "G" => 4,
                    "H" => 5,
                    "SE" => 6,
                    "SO" => 7,
                    "SF" => 8,
                    "SD" => 9,
                    "FT" => 10,
                    _ => 11,
                };
                let (a, b) = if kind == 4 {
                    (self.atom(fields[2])?, self.atom(fields[1])?)
                } else {
                    (
                        self.atom(fields[1])?,
                        self.atom(fields.get(2).copied().unwrap_or("*"))?,
                    )
                };
                let (chunk, relaxed) = if kind == 7 || kind == 9 {
                    (state.chunk, state.relaxed)
                } else {
                    (0, false)
                };
                self.execute(
                    "INSERT OR IGNORE INTO relation VALUES(?,?,?,?,?)",
                    params![kind, a, b, chunk, relaxed],
                )?;
            }
            "SL" => {
                need(4)?;
                self.execute(
                    "INSERT OR IGNORE INTO slot_link VALUES(?,?,?)",
                    params![
                        self.atom(fields[1])?,
                        self.atom(fields[2])?,
                        self.atom(fields[3])?
                    ],
                )?;
            }
            "SC" => {
                need(4)?;
                self.execute(
                    "INSERT INTO call_site(site,callee,caller) VALUES(?,?,?)",
                    params![
                        self.atom(fields[1])?,
                        self.atom(fields[2])?,
                        self.atom(fields[3])?
                    ],
                )?;
            }
            "SA" => {
                need(4)?;
                self.execute(
                    "INSERT OR IGNORE INTO argument VALUES(?,?,?)",
                    params![
                        self.atom(fields[1])?,
                        fields[2].parse::<u32>().unwrap_or(0),
                        self.atom(fields[3])?
                    ],
                )?;
            }
            "JS" | "JL" => {
                self.execute("INSERT OR IGNORE INTO jmp(line) VALUES(?)", [text])?;
            }
            "R" => {
                need(3)?;
                let registry = self.atom(fields[1])?;
                let unknown = match fields[2] {
                    "*" | "?" => true,
                    value if value.starts_with('%') => {
                        need(4)?;
                        let parameter = value[1..]
                            .parse::<u32>()
                            .context("bad registration forwarder")?;
                        !super::side::REG_APIS
                            .iter()
                            .any(|&(_, m, a, r)| m == fields[3] && a == parameter && r == fields[1])
                    }
                    name => {
                        let name = self.atom(name)?;
                        self.execute(
                            "INSERT OR IGNORE INTO registered VALUES(?,?)",
                            params![registry, name],
                        )?;
                        if let Some((_, caller)) = state.current {
                            self.execute(
                                "INSERT OR IGNORE INTO registered_by VALUES(?,?,?)",
                                params![registry, caller, name],
                            )?;
                        }
                        false
                    }
                };
                if unknown {
                    self.execute(
                        "INSERT OR IGNORE INTO unknown_registry VALUES(?)",
                        [registry],
                    )?;
                }
            }
            _ => {}
        }
        Ok(())
    }
}

#[derive(Default)]
struct ParseState {
    chunk: i64,
    ordinal: i64,
    module: i64,
    current: Option<(i64, i64)>,
    relaxed: bool,
}
fn number(text: &str) -> Result<i64> {
    Ok(
        i64::try_from(text.parse::<usize>().context("bad facts number")?)
            .context("facts number exceeds storage range")?,
    )
}
