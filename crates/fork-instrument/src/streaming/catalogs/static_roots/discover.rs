use super::*;
use wasmparser::{
    AbstractHeapType, ElementItems, ElementKind, HeapType, Operator, Parser, Payload, TableInit,
    TypeRef,
};

struct Discovery<'s, 'a> {
    scan: &'s Scan<'a>,
    types: SourceTypes,
    roots: Vec<Root>,
    globals: BTreeMap<u32, u32>,
    metadata: usize,
    work: usize,
}
#[derive(Clone, Copy)]
enum Initializer {
    Alias(u32),
    Trivial,
    Value,
}
impl Discovery<'_, '_> {
    fn charge(&mut self, bytes: usize) -> Result<()> {
        self.metadata = self
            .metadata
            .checked_sub(bytes)
            .context("static roots exceed metadata budget")?;
        Ok(())
    }
    fn step(&mut self) -> Result<()> {
        self.work = self
            .work
            .checked_sub(1)
            .context("static roots exceed work budget")?;
        Ok(())
    }
    fn root(&mut self, root: Root) -> Result<u32> {
        self.charge(64)?;
        u32::try_from(
            self.roots
                .len()
                .checked_add(1)
                .context("static root count overflow")?,
        )?;
        let ordinal = u32::try_from(self.roots.len())?;
        self.roots.push(root);
        Ok(ordinal)
    }
    fn global(&mut self, index: u32) -> Result<u32> {
        if let Some(&ordinal) = self.globals.get(&index) {
            return Ok(ordinal);
        }
        self.charge(128)?;
        let ordinal = self.root(Root::Global(index))?;
        self.globals.insert(index, ordinal);
        Ok(ordinal)
    }
    fn eligible(&self, reference: wasmparser::RefType) -> Result<bool> {
        Ok(match reference.heap_type() {
            HeapType::Abstract { ty, .. } => matches!(
                ty,
                AbstractHeapType::Any
                    | AbstractHeapType::None
                    | AbstractHeapType::Eq
                    | AbstractHeapType::Struct
                    | AbstractHeapType::Array
                    | AbstractHeapType::I31
            ),
            HeapType::Concrete(index) | HeapType::Exact(index) => {
                let source = self.types.source_index(index)?;
                let types = self.scan.types.as_ref();
                let ty = types
                    .get(types.core_type_at_in_module(source))
                    .context("unknown static root heap type")?;
                matches!(
                    ty.composite_type.inner,
                    wasmparser::CompositeInnerType::Struct(_)
                        | wasmparser::CompositeInnerType::Array(_)
                )
            }
        })
    }
    fn initializer(&mut self, expr: wasmparser::ConstExpr<'_>) -> Result<Initializer> {
        let mut reader = expr.get_operators_reader();
        self.step()?;
        let first = match reader.read()? {
            Operator::GlobalGet { global_index } => Initializer::Alias(global_index),
            Operator::RefNull { .. } | Operator::RefFunc { .. } => Initializer::Trivial,
            _ => Initializer::Value,
        };
        self.step()?;
        if matches!(reader.read()?, Operator::End) && reader.eof() {
            return Ok(first);
        }
        while !reader.eof() {
            self.step()?;
            reader.read()?;
        }
        Ok(Initializer::Value)
    }
    fn globals(&mut self) -> Result<()> {
        let mut index = 0u32;
        for payload in Parser::new(0).parse_all(self.scan.input()) {
            match payload? {
                Payload::ImportSection(section) => {
                    for import in section.into_imports() {
                        self.step()?;
                        if let TypeRef::Global(global) = import?.ty {
                            if !global.mutable {
                                if let wasmparser::ValType::Ref(reference) = global.content_type {
                                    if self.eligible(reference)? {
                                        self.global(index)?;
                                    }
                                }
                            }
                            index += 1;
                        }
                    }
                }
                Payload::GlobalSection(section) => {
                    for global in section {
                        self.step()?;
                        let global = global?;
                        if !global.ty.mutable {
                            if let wasmparser::ValType::Ref(reference) = global.ty.content_type {
                                if self.eligible(reference)? {
                                    match self.initializer(global.init_expr)? {
                                        Initializer::Alias(target) => {
                                            let ordinal = self.global(target)?;
                                            self.charge(128)?;
                                            self.globals.insert(index, ordinal);
                                        }
                                        Initializer::Trivial => {}
                                        Initializer::Value => {
                                            self.global(index)?;
                                        }
                                    }
                                }
                            }
                        }
                        index += 1;
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
    fn tables(&mut self) -> Result<()> {
        let mut index = 0u32;
        for payload in Parser::new(0).parse_all(self.scan.input()) {
            match payload? {
                Payload::ImportSection(section) => {
                    for import in section.into_imports() {
                        self.step()?;
                        if matches!(import?.ty, TypeRef::Table(_)) {
                            index += 1;
                        }
                    }
                }
                Payload::TableSection(section) => {
                    for table in section {
                        self.step()?;
                        let table = table?;
                        if table.ty.initial != 0 && self.eligible(table.ty.element_type)? {
                            if let TableInit::Expr(expr) = table.init {
                                match self.initializer(expr)? {
                                    Initializer::Alias(global) => {
                                        self.global(global)?;
                                    }
                                    Initializer::Trivial => {}
                                    Initializer::Value => {
                                        self.root(Root::Table {
                                            index,
                                            wide: table.ty.table64,
                                        })?;
                                    }
                                }
                            }
                        }
                        index += 1;
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
    fn elements(&mut self) -> Result<()> {
        for payload in Parser::new(0).parse_all(self.scan.input()) {
            if let Payload::ElementSection(section) = payload? {
                for (segment, element) in section.into_iter().enumerate() {
                    self.step()?;
                    let element = element?;
                    // Declared segments are dropped by instantiation and have
                    // no observable element identity to harvest afterward.
                    if matches!(element.kind, ElementKind::Declared) {
                        continue;
                    }
                    let ElementItems::Expressions(reference, expressions) = element.items else {
                        continue;
                    };
                    if !self.eligible(reference)? {
                        continue;
                    }
                    for (item, expr) in expressions.into_iter().enumerate() {
                        match self.initializer(expr?)? {
                            Initializer::Alias(global) => {
                                self.global(global)?;
                            }
                            Initializer::Trivial => {}
                            Initializer::Value => {
                                self.root(Root::Element {
                                    segment: u32::try_from(segment)?,
                                    item: u32::try_from(item)?,
                                })?;
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }
}
pub(super) fn plan(scan: &Scan<'_>, limits: StaticRootLimits) -> Result<StaticRootPlan> {
    ensure!(
        scan.types.as_ref().core_type_count_in_module() as usize <= limits.metadata_bytes / 128,
        "static root types exceed metadata budget"
    );
    let type_bytes = scan.types.as_ref().core_type_count_in_module() as usize * 128;
    let mut discovery = Discovery {
        scan,
        types: SourceTypes::new(scan),
        roots: Vec::new(),
        globals: BTreeMap::new(),
        metadata: limits.metadata_bytes - type_bytes,
        work: limits.work,
    };
    discovery.globals()?;
    discovery.tables()?;
    discovery.elements()?;
    Ok(StaticRootPlan {
        source: scan.source_fingerprint(),
        roots: discovery.roots,
        limits,
    })
}
