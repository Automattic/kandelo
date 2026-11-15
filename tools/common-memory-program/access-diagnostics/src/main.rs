//! Separate, deliberately expensive diagnostic pass. Never use its artifacts
//! as latency samples. Original function/global indices remain unchanged.
use anyhow::{Context, Result, ensure};
use std::{borrow::Cow, collections::BTreeMap, fs};
use wasm_encoder::{
    self as e, Instruction as I, ValType as V,
    reencode::{self, Reencode},
};
use wasmparser::{self as p, Operator as O, Parser, Payload};
mod origin_sites;
const FUNCTION_BASE: u32 = 256;
const SLOTS: u32 = FUNCTION_BASE + 65536;
const MAGIC: i32 = 0x4b564d31;
fn mem(offset: u64, align: u32) -> e::MemArg {
    e::MemArg {
        offset,
        align,
        memory_index: 0,
    }
}
fn uload(f: &mut e::Function, root: u32, offset: u64) {
    f.instruction(&I::GlobalGet(root));
    f.instruction(&I::I32Load(mem(offset, 2)));
}
fn counter(root: u32) -> e::Function {
    let mut f = e::Function::new([]);
    uload(&mut f, root, 60);
    f.instruction(&I::I32Const(MAGIC));
    f.instruction(&I::I32Ne);
    f.instruction(&I::If(e::BlockType::Empty));
    f.instruction(&I::Unreachable);
    f.instruction(&I::End);
    uload(&mut f, root, 56);
    f.instruction(&I::LocalGet(0));
    f.instruction(&I::I32Const(3));
    f.instruction(&I::I32Shl);
    f.instruction(&I::I32Add);
    f.instruction(&I::I64Const(1));
    f.instruction(&I::I64AtomicRmwAdd(mem(0, 3)));
    f.instruction(&I::Drop);
    f.instruction(&I::End);
    f
}
fn count(f: &mut e::Function, index: u32, slot: u32) {
    f.instruction(&I::I32Const(slot as i32));
    f.instruction(&I::Call(index));
}
fn operation(op: &O<'_>) -> Option<String> {
    let s = format!("{op:?}");
    if s.contains("memarg:") {
        Some(s.split_whitespace().next().unwrap().to_owned())
    } else {
        None
    }
}
struct Rewrite {
    source_functions: u32,
    imports: u32,
    body: u32,
    total_functions: u32,
    type_count: u32,
    root: u32,
    first_wrapper: u32,
    last_wrapper: u32,
    wrappers: BTreeMap<u32, u32>,
    metadata: serde_json::Value,
    static_counts: BTreeMap<u32, u64>,
    regional: Option<Regional>,
    origin_sites: Option<origin_sites::OriginSites>,
    category_names: Vec<String>,
}
#[derive(Clone)]
struct Region {
    id: u32,
    sites: u64,
    base: u32,
    span: u32,
    rights: u32,
}
struct Regional {
    guard: u32,
    base: u32,
    plans: BTreeMap<u32, Vec<Region>>,
    operation_slots: BTreeMap<String, u32>,
    metadata: serde_json::Value,
    seen: u32,
}
impl Reencode for Rewrite {
    type Error = anyhow::Error;
    fn parse_type_section(
        &mut self,
        s: &mut e::TypeSection,
        r: p::TypeSectionReader<'_>,
    ) -> Result<(), reencode::Error<anyhow::Error>> {
        reencode::utils::parse_type_section(self, s, r)?;
        s.ty().function([V::I32], []);
        Ok(())
    }
    fn parse_function_section(
        &mut self,
        s: &mut e::FunctionSection,
        r: p::FunctionSectionReader<'_>,
    ) -> Result<(), reencode::Error<anyhow::Error>> {
        reencode::utils::parse_function_section(self, s, r)?;
        s.function(self.type_count);
        Ok(())
    }
    fn parse_custom_section(
        &mut self,
        module: &mut e::Module,
        r: p::CustomSectionReader<'_>,
    ) -> Result<(), reencode::Error<anyhow::Error>> {
        if r.name() == "kandelo.common-memory.prototype" {
            let mut m = self.metadata.clone();
            m["accessDiagnostics"] = serde_json::json!({"version":1,"magic":MAGIC,"slots":SLOTS,"functionBase":FUNCTION_BASE,"counterFunction":self.total_functions,"categories":self.wrappers});
            if let Some(regional) = &self.regional {
                m["accessDiagnostics"]["regional"] = regional.metadata.clone();
            }
            if let Some(origin_sites) = &self.origin_sites {
                m["accessDiagnostics"]["originSites"] = origin_sites.metadata.clone();
            }
            module.section(&e::CustomSection {
                name: Cow::Borrowed(r.name()),
                data: Cow::Owned(serde_json::to_vec(&m).unwrap()),
            });
            Ok(())
        } else {
            reencode::utils::parse_custom_section(self, module, r)
        }
    }
    fn parse_code_section(
        &mut self,
        s: &mut e::CodeSection,
        r: p::CodeSectionReader<'_>,
    ) -> Result<(), reencode::Error<anyhow::Error>> {
        reencode::utils::parse_code_section(self, s, r)?;
        s.function(&counter(self.root));
        Ok(())
    }
    fn parse_function_body(
        &mut self,
        s: &mut e::CodeSection,
        b: p::FunctionBody<'_>,
    ) -> Result<(), reencode::Error<anyhow::Error>> {
        let function = self.imports + self.body;
        self.body += 1;
        let mut f = e::Function::new(
            b.get_locals_reader()?
                .into_iter()
                .map(|x| x.map(|(n, t)| (n, reencode::RoundtripReencoder.val_type(t).unwrap())))
                .collect::<Result<Vec<_>, _>>()?,
        );
        // Counters use only physical host-owned diagnostic pages and never retain
        // a guest pointer, call the host, or create a fork-live temporary.
        if let Some(slot) = self.wrappers.get(&function) {
            count(&mut f, self.total_functions, *slot);
        }
        let ops = b
            .get_operators_reader()?
            .into_iter()
            .collect::<Result<Vec<_>, _>>()?;
        let origin_masks = if function < self.source_functions {
            if let Some(origin_sites) = &mut self.origin_sites {
                origin_sites
                    .calls(
                        function,
                        &ops,
                        self.first_wrapper,
                        self.last_wrapper,
                        &self.wrappers,
                        &self.category_names,
                    )
                    .map_err(reencode::Error::UserError)?
            } else {
                BTreeMap::new()
            }
        } else {
            BTreeMap::new()
        };
        let mut guards = BTreeMap::new();
        let mut hits = BTreeMap::new();
        let mut misses = BTreeMap::new();
        let mut fast = BTreeMap::new();
        if function < self.source_functions {
            if let Some(regional) = &mut self.regional {
                let expected = regional.plans.get(&function).cloned().unwrap_or_default();
                let mut next = 0;
                for (ordinal, op) in ops.iter().enumerate() {
                    if !matches!(op, O::Call { function_index } if *function_index == regional.guard)
                    {
                        continue;
                    }
                    let plan = expected.get(next).ok_or_else(|| {
                        reencode::Error::UserError(anyhow::anyhow!(
                            "unexpected region guard in {function}"
                        ))
                    })?;
                    next += 1;
                    if ordinal < 4
                        || !matches!(ops[ordinal - 4], O::LocalGet { local_index } if local_index == plan.base)
                        || !matches!(ops[ordinal - 3], O::I32Const { value } if value as u32 == plan.span)
                        || !matches!(ops[ordinal - 2], O::I32Const { value } if value as u32 == plan.rights)
                        || !matches!(ops[ordinal - 1], O::GlobalGet { global_index } if global_index == self.root)
                    {
                        return Err(reencode::Error::UserError(anyhow::anyhow!(
                            "region guard parameters do not match plan"
                        )));
                    }
                    if !matches!(ops.get(ordinal + 1), Some(O::LocalTee { .. }))
                        || !matches!(
                            ops.get(ordinal + 2),
                            Some(O::If {
                                blockty: p::BlockType::Empty
                            })
                        )
                    {
                        return Err(reencode::Error::UserError(anyhow::anyhow!(
                            "unexpected region guard shape"
                        )));
                    }
                    guards.insert(ordinal, plan.id);
                    hits.insert(ordinal + 2, plan.id);
                    let mut end = ordinal + 3;
                    let mut sites = 0;
                    loop {
                        let op = ops.get(end).ok_or_else(|| {
                            reencode::Error::UserError(anyhow::anyhow!("missing region else"))
                        })?;
                        if matches!(op, O::Else) {
                            break;
                        }
                        // The existing proof admits no call or control edge in
                        // a fast region. Refuse an unfamiliar generated shape.
                        if matches!(
                            op,
                            O::Block { .. }
                                | O::Loop { .. }
                                | O::If { .. }
                                | O::Try { .. }
                                | O::TryTable { .. }
                                | O::End
                                | O::Call { .. }
                                | O::CallIndirect { .. }
                                | O::CallRef { .. }
                        ) {
                            return Err(reencode::Error::UserError(anyhow::anyhow!(
                                "control inside region fast body"
                            )));
                        }
                        if operation(op).is_some() {
                            sites += 1;
                            fast.insert(end, plan.id);
                        }
                        end += 1;
                    }
                    if sites != plan.sites {
                        return Err(reencode::Error::UserError(anyhow::anyhow!(
                            "region {function}:{} fast-site count {sites} != {}",
                            plan.id,
                            plan.sites
                        )));
                    }
                    misses.insert(end, plan.id);
                    regional.seen += 1;
                }
                if next != expected.len() {
                    return Err(reencode::Error::UserError(anyhow::anyhow!(
                        "missing region guard in {function}"
                    )));
                }
            }
        }
        for (ordinal, op) in ops.into_iter().enumerate() {
            if let Some(mask) = origin_masks.get(&ordinal) {
                for bit in 0..self
                    .origin_sites
                    .as_ref()
                    .expect("site masks require classes")
                    .class_count()
                {
                    if mask & (1 << bit) != 0 {
                        count(
                            &mut f,
                            self.total_functions,
                            origin_sites::FIRST_SLOT + bit as u32,
                        );
                    }
                }
            }
            if function < self.source_functions {
                if let Some(regional) = &self.regional {
                    if guards.contains_key(&ordinal) {
                        count(&mut f, self.total_functions, 192);
                    }
                    if let Some(name) = operation(&op) {
                        if !fast.contains_key(&ordinal) {
                            return Err(reencode::Error::UserError(anyhow::anyhow!(
                                "unaccounted raw memory operation in source function {function}"
                            )));
                        }
                        let slot = regional.operation_slots.get(&name).ok_or_else(|| {
                            reencode::Error::UserError(anyhow::anyhow!(
                                "unknown fast access {name}"
                            ))
                        })?;
                        count(&mut f, self.total_functions, *slot);
                        count(&mut f, self.total_functions, FUNCTION_BASE + function);
                        count(&mut f, self.total_functions, 195);
                        *self.static_counts.entry(function).or_default() += 1;
                    }
                }
                let relevant = matches!(op,O::Call{function_index} if (self.first_wrapper..=self.last_wrapper).contains(&function_index))
                    || matches!(op,O::Call{function_index} if self.wrappers.contains_key(&function_index));
                if relevant {
                    count(&mut f, self.total_functions, FUNCTION_BASE + function);
                    *self.static_counts.entry(function).or_default() += 1;
                }
            }
            f.instruction(&self.instruction(op)?);
            if let Some(regional) = &self.regional {
                if let Some(id) = hits.get(&ordinal) {
                    count(&mut f, self.total_functions, 193);
                    count(&mut f, self.total_functions, regional.base + 2 * id);
                }
                if let Some(id) = misses.get(&ordinal) {
                    count(&mut f, self.total_functions, 194);
                    count(&mut f, self.total_functions, regional.base + 2 * id + 1);
                }
            }
        }
        s.function(&f);
        Ok(())
    }
}
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    ensure!(
        args.len() == 5
            || (args.len() == 7 && args[5] == "--region-plans")
            || (args.len() == 7 && args[5] == "--origin-sites")
            || (args.len() == 7 && args[5] == "--writer-loop-sites")
            || (args.len() == 7 && args[5] == "--constant-sites"),
        "usage: access-diagnostics INPUT HELPERS OUTPUT REPORT [--region-plans PLAN_REPORT | --origin-sites NATIVE_MODULE | --writer-loop-sites NATIVE_MODULE | --constant-sites NATIVE_MODULE]"
    );
    ensure!(
        !std::path::Path::new(&args[3]).exists() && !std::path::Path::new(&args[4]).exists(),
        "choose fresh outputs"
    );
    let bytes = fs::read(&args[1])?;
    let regional_requested = args.len() == 7 && args[5] == "--region-plans";
    let origin_requested = args.len() == 7 && args[5] == "--origin-sites";
    let writer_requested = args.len() == 7 && args[5] == "--writer-loop-sites";
    let constant_requested = args.len() == 7 && args[5] == "--constant-sites";
    p::Validator::new_with_features(p::WasmFeatures::all()).validate_all(&bytes)?;
    let (mut metadata, mut types, mut imports, mut defined, mut init) = (None, 0, 0, 0, None);
    let mut exports = BTreeMap::new();
    let mut bodies = vec![];
    for payload in Parser::new(0).parse_all(&bytes) {
        match payload? {
            Payload::TypeSection(s) => types = s.count(),
            Payload::FunctionSection(s) => defined = s.count(),
            Payload::ImportSection(s) => {
                for i in s.into_imports() {
                    if matches!(i?.ty, p::TypeRef::Func(_)) {
                        imports += 1;
                    }
                }
            }
            Payload::ExportSection(s) => {
                for ex in s {
                    let ex = ex?;
                    exports.insert(ex.name.to_owned(), (ex.kind, ex.index));
                    if ex.name == "__vm_initialize" {
                        init = Some(ex.index);
                    }
                }
            }
            Payload::CustomSection(s) if s.name() == "kandelo.common-memory.prototype" => {
                ensure!(metadata.is_none(), "duplicate metadata");
                metadata = Some(serde_json::from_slice::<serde_json::Value>(s.data())?);
            }
            Payload::CodeSectionEntry(b) => bodies.push(b),
            _ => {}
        }
    }
    let metadata = metadata.ok_or_else(|| anyhow::anyhow!("requires translated metadata"))?;
    ensure!(
        metadata["accessDiagnostics"].is_null(),
        "already instrumented"
    );
    ensure!(
        metadata["mappingCache"].is_null(),
        "diagnostic header conflicts with mapping cache"
    );
    ensure!(
        metadata["guardedObjects"].is_null(),
        "object-guard counting needs separate accounting"
    );
    ensure!(
        metadata["accessProfile"] == "outlined",
        "requires outlined accesses"
    );
    let source_functions = metadata["sourceFunctions"].as_u64().unwrap() as u32;
    ensure!(source_functions <= 65536, "function budget");
    let first = init.unwrap() + 1;
    let last = first + metadata["accessWrappers"].as_u64().unwrap() as u32 - 1;
    ensure!(
        last + 1 == imports + defined,
        "unexpected appended functions"
    );
    let mut kinds = BTreeMap::new();
    let mut category_names = vec![];
    let mut wrappers = BTreeMap::new();
    for function in first..=last {
        let b = &bodies[(function - imports) as usize];
        let mut ops = b.get_operators_reader()?;
        let mut kind = None;
        while !ops.eof() {
            if let Some(name) = operation(&ops.read()?) {
                kind = Some(name);
            }
        }
        let kind = kind.ok_or_else(|| anyhow::anyhow!("missing access in wrapper {function}"))?;
        let slot = *kinds.entry(kind.clone()).or_insert_with(|| {
            let slot = category_names.len() as u32;
            category_names.push(kind);
            slot
        });
        ensure!(slot < 128, "category budget");
        wrappers.insert(function, slot);
    }
    // Bulk helper calls are rewritten directly rather than through wrappers.
    let helper_bytes = fs::read(&args[2])?;
    let mut helper_exports = BTreeMap::new();
    let mut helper_functions = 0;
    for payload in Parser::new(0).parse_all(&helper_bytes) {
        match payload? {
            Payload::ImportSection(s) => {
                for i in s.into_imports() {
                    ensure!(
                        !matches!(i?.ty, p::TypeRef::Func(_)),
                        "helper function imports"
                    );
                }
            }
            Payload::FunctionSection(s) => helper_functions = s.count(),
            Payload::ExportSection(s) => {
                for x in s {
                    let x = x?;
                    if x.kind == p::ExternalKind::Func {
                        helper_exports.insert(x.name.to_owned(), x.index);
                    }
                }
            }
            _ => {}
        }
    }
    ensure!(
        helper_functions == if regional_requested { 12 } else { 11 }
            && helper_exports.get("vm_span") == Some(&0),
        "requires the original helper layout, with exactly one additional regional guard when requested"
    );
    // Compare canonical helper bodies against the actual merged input. This
    // helper has no internal calls, globals or static data, so no remapping is
    // needed; reject a different helper instead of trusting an index convention.
    let mut hbody = 0;
    for payload in Parser::new(0).parse_all(&helper_bytes) {
        if let Payload::CodeSectionEntry(h) = payload? {
            let actual = &bodies[(source_functions - imports + hbody) as usize];
            ensure!(
                h.as_bytes() == actual.as_bytes(),
                "merged helper mismatch at {hbody}"
            );
            hbody += 1;
        }
    }
    for (name, slot) in [
        ("vm_copy", 128),
        ("vm_fill", 129),
        ("vm_size", 130),
        ("vm_grow", 131),
    ] {
        let helper = source_functions + helper_exports[name];
        wrappers.insert(helper, slot);
    }
    for data_init in source_functions + helper_functions..init.unwrap() {
        wrappers.insert(data_init, 132);
    }
    let root = metadata["rootGlobal"].as_u64().unwrap() as u32;
    let mut regional_report = None;
    let regional = if regional_requested {
        let report: serde_json::Value = serde_json::from_slice(&fs::read(&args[6])?)?;
        ensure!(
            report["guardedRegions"] == metadata["guardedRegions"]
                && !report["guardedRegions"].is_null(),
            "regional metadata mismatch"
        );
        ensure!(
            report["sourceFunctions"] == metadata["sourceFunctions"],
            "regional source count mismatch"
        );
        let entries = report["regionPlans"]
            .as_array()
            .context("missing region plans")?;
        ensure!(
            entries.len() as u64
                == metadata["guardedRegions"]["selectedRegions"]
                    .as_u64()
                    .unwrap(),
            "region inventory mismatch"
        );
        let base = FUNCTION_BASE + source_functions;
        ensure!(
            u64::from(base) + 2 * entries.len() as u64 <= u64::from(SLOTS),
            "per-region counter budget exceeded"
        );
        let mut plans = BTreeMap::<u32, Vec<Region>>::new();
        for (id, entry) in entries.iter().enumerate() {
            let function = u32::try_from(entry["function"].as_u64().context("region function")?)?;
            ensure!(
                function < source_functions,
                "region function outside source"
            );
            plans.entry(function).or_default().push(Region {
                id: id as u32,
                sites: entry["sites"].as_u64().context("region sites")?,
                base: u32::try_from(entry["baseLocal"].as_u64().context("region base")?)?,
                span: u32::try_from(entry["spanBytes"].as_u64().context("region span")?)?,
                rights: u32::try_from(entry["rights"].as_u64().context("region rights")?)?,
            });
        }
        let regional_metadata = serde_json::json!({"version":1,"regionBase":base,"regionCount":entries.len(),"functionEnd":FUNCTION_BASE+source_functions,"guardAttemptsSlot":192,"guardHitsSlot":193,"guardMissesSlot":194,"fastAccessesSlot":195,"scope":"Attempted original access dispatches plus guard branches. Per-region hit/miss counters follow function slots; weighted sites are an upper bound when a later arithmetic operation traps."});
        regional_report = Some(serde_json::json!({"metadata":regional_metadata,"plans":entries}));
        Some(Regional {
            guard: source_functions
                + *helper_exports
                    .get("vm_try_span")
                    .context("missing regional helper")?,
            base,
            plans,
            operation_slots: kinds,
            metadata: regional_metadata,
            seen: 0,
        })
    } else {
        ensure!(
            metadata["guardedRegions"].is_null(),
            "regional modules require explicit region plans"
        );
        None
    };
    let origin_sites = if origin_requested || writer_requested || constant_requested {
        let constructor = if constant_requested {
            origin_sites::OriginSites::with_constants
        } else if writer_requested {
            origin_sites::OriginSites::with_writer_loops
        } else {
            origin_sites::OriginSites::new
        };
        Some(constructor(
            &fs::read(&args[6])?,
            source_functions,
            imports,
        )?)
    } else {
        None
    };
    let mut rewrite = Rewrite {
        source_functions,
        imports,
        body: 0,
        total_functions: imports + defined,
        type_count: types,
        root,
        first_wrapper: first,
        last_wrapper: last,
        wrappers,
        metadata,
        static_counts: BTreeMap::new(),
        regional,
        origin_sites,
        category_names: category_names.clone(),
    };
    let mut module = e::Module::new();
    rewrite
        .parse_core_module(&mut module, Parser::new(0), &bytes)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let output = module.finish();
    p::Validator::new_with_features(p::WasmFeatures::all()).validate_all(&output)?;
    let mut report = serde_json::json!({"scope":"Diagnostic operation dispatch counters; not latency. Counts attempted operations at wrapper/helper entry; faults may interrupt their completion. Individual atomic counters, not a globally atomic snapshot.","magic":MAGIC,"slots":SLOTS,"functionBase":FUNCTION_BASE,"sourceFunctions":source_functions,"categoryNames":category_names,"bulkCategories":{"128":"MemoryCopy","129":"MemoryFill","130":"MemorySize","131":"MemoryGrow","132":"MemoryInit"},"staticAccessCallsByFunction":rewrite.static_counts,"wrapperCategories":rewrite.wrappers,"inputBytes":bytes.len(),"outputBytes":output.len()});
    if let Some(origin_sites) = &rewrite.origin_sites {
        origin_sites.finish()?;
        report["originSites"] = origin_sites.metadata.clone();
    }
    if let Some(regional) = regional_report {
        ensure!(
            rewrite.regional.as_ref().unwrap().seen as u64
                == regional["metadata"]["regionCount"].as_u64().unwrap(),
            "not all guards accounted"
        );
        report["regional"] = regional;
    }
    fs::write(&args[3], output)?;
    fs::write(&args[4], serde_json::to_vec_pretty(&report)?)?;
    Ok(())
}
