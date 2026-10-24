//! Function-local typed IR, independent of Walrus. Every node borrows only
//! immutable original bytes; no module-wide instruction arena is constructed.

use anyhow::{Context, Result, ensure};
use wasm_encoder::reencode::Reencode;
use wasmparser::{BlockType, Catch, Operator, Payload, ValType, ValidPayload};

use super::ProgramPoint;

/// Limits apply before expanding locals, branch labels and landing stacks.
#[derive(Clone, Copy, Debug)]
pub struct IrLimits {
    pub body_bytes: usize,
    pub instructions: usize,
    pub locals: usize,
    pub landing_stack_values: usize,
    pub branch_targets: usize,
}

impl Default for IrLimits {
    fn default() -> Self {
        Self {
            body_bytes: 32 * 1024 * 1024,
            instructions: 1_000_000,
            locals: 1_000_000,
            landing_stack_values: 1_000_000,
            branch_targets: 1_000_000,
        }
    }
}

/// Local region IDs survive insertion/removal of instruction-vector entries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RegionId(pub usize);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegionKind {
    Function,
    Block,
    Loop,
    If,
    LegacyTry,
    TryTable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandlerKind {
    Catch,
    CatchRef,
    CatchAll,
    CatchAllRef,
}

#[derive(Clone, Debug)]
pub struct Handler {
    /// Exact arm ordinal, including catch-all and reference clauses.
    pub ordinal: usize,
    pub kind: HandlerKind,
    pub tag: Option<u32>,
    /// Modern clauses branch to an outer region; legacy clauses start inline.
    pub target: Option<RegionId>,
    pub instruction: usize,
}

#[derive(Debug)]
pub struct Region {
    pub kind: RegionKind,
    pub signature: BlockType,
    pub parent: Option<RegionId>,
    pub opener: Option<usize>,
    pub end: usize,
    pub alternative: Option<usize>,
    pub handlers: Vec<Handler>,
    pub delegate: Option<RegionId>,
    /// Absolute operand floor of this control frame. Values below it belong
    /// to enclosing regions and cannot be spilled by an inner call landing.
    pub operand_base: usize,
    /// Parent-region operand values before this opener, including its inputs
    /// and an if condition. Replay reconstructs these at the region landing.
    pub input_stack: Vec<Option<ValType>>,
}

#[derive(Debug)]
pub struct SourceInstruction<'a> {
    pub point: ProgramPoint,
    pub operation: Operator<'a>,
    pub region: RegionId,
    pub opens: Option<RegionId>,
    /// False for detached regions as well as locally unreachable suffixes.
    pub reachable: bool,
    /// Lexically attached under the oracle parser's policy. This includes
    /// tail-call suffixes even when validation marks them unreachable.
    pub retained: bool,
    /// Validator-derived stack effect before executing the original operator.
    /// Control-transfer operators may have no context-independent arity.
    pub arity: Option<(u32, u32)>,
    pub operand_height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransferKind {
    Branch,
    Conditional,
    Table,
    Return,
    Rethrow,
}

#[derive(Debug)]
pub struct Transfer {
    pub instruction: usize,
    pub kind: TransferKind,
    /// A branch table includes its default as the last target.
    pub targets: Vec<RegionId>,
}

#[derive(Debug)]
pub struct TypedCall {
    pub instruction: usize,
    pub operand_base: usize,
    /// Bottom-to-top, immediately before the original invocation. Types may
    /// contain validator-canonical heap IDs; use the original type catalog
    /// when assigning concrete emitted type indices.
    pub operand_stack: Vec<Option<ValType>>,
}

/// All instruction/control/typing state for exactly one source function.
#[derive(Debug)]
pub struct FunctionIr<'a> {
    pub function: u32,
    pub type_index: u32,
    pub source: wasmparser::FunctionBody<'a>,
    /// Parameters followed by the original locals (validator-canonical types).
    pub locals: Vec<ValType>,
    pub instructions: Vec<SourceInstruction<'a>>,
    pub regions: Vec<Region>,
    pub transfers: Vec<Transfer>,
    pub calls: Vec<TypedCall>,
}

impl FunctionIr<'_> {
    /// Lossless operator re-encoding, with all original index references sent
    /// through the supplied frozen mapping, including unreachable operators.
    pub fn emit<T: Reencode + ?Sized>(
        &self,
        map: &mut T,
        limit: usize,
    ) -> Result<wasm_encoder::Function>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        let mut output = map.new_function_with_parsed_locals(&self.source)?;
        for instruction in &self.instructions {
            output.instruction(&map.instruction(instruction.operation.clone())?);
            ensure!(
                output.byte_len() <= limit,
                "function IR emission exceeds output budget"
            );
        }
        Ok(output)
    }
}

/// Random access to validated original bodies for whole-program fixed points.
/// Header/type resources are shared with the scan. No instruction cache and no
/// vector of pending per-function validators is retained. Callers own returned
/// IR and must discard it or enforce a bounded specialization stack.
pub struct BodyProvider<'s, 'a> {
    scan: &'s super::Scan<'a>,
    allocations: wasmparser::FuncValidatorAllocations,
    limits: IrLimits,
}

impl<'a> super::Scan<'a> {
    pub fn body_provider(&self, limits: IrLimits) -> BodyProvider<'_, 'a> {
        BodyProvider {
            scan: self,
            allocations: Default::default(),
            limits,
        }
    }
}

impl<'a> BodyProvider<'_, 'a> {
    pub fn load(&mut self, function: u32) -> Result<FunctionIr<'a>> {
        use wasmparser::WasmModuleResources;
        let summary = self
            .scan
            .functions
            .get(function as usize)
            .context("unknown source function")?;
        let body = summary
            .body
            .as_ref()
            .context("imported function has no source body")?;
        ensure!(
            body.range.len() <= self.limits.body_bytes,
            "function IR source exceeds body budget"
        );
        let instructions = usize::try_from(body.operators).context("operator count overflow")?;
        let resources = self
            .scan
            .body_resources
            .as_ref()
            .context("module has no source body resources")?
            .clone();
        ensure!(
            resources.type_index_of_function(function) == Some(summary.ty),
            "source function type does not match validated metadata"
        );
        let source = self
            .scan
            .input()
            .get(body.range.clone())
            .context("source body range outside original input")?;
        let body = wasmparser::FunctionBody::new(wasmparser::BinaryReader::new_features(
            source,
            body.range.start,
            super::features(),
        ));
        let mut validator = wasmparser::FuncToValidate {
            resources,
            index: function,
            ty: summary.ty,
            features: super::features(),
        }
        .into_validator(std::mem::take(&mut self.allocations));
        let result = decode(
            function,
            summary.ty,
            body,
            &mut validator,
            self.limits,
            Some(instructions),
        );
        self.allocations = validator.into_allocations();
        result
    }
}

/// A serial typed-body provider. Dropping each yielded body before requesting
/// the next bounds retained IR to one function. Metadata and input bytes are
/// shared with the caller; reusable validator allocations stay in the provider.
pub struct FunctionBodies<'a> {
    payloads: Box<dyn Iterator<Item = wasmparser::Result<Payload<'a>>> + 'a>,
    validator: wasmparser::Validator,
    allocations: wasmparser::FuncValidatorAllocations,
    limits: IrLimits,
    finished: bool,
}

impl<'a> FunctionBodies<'a> {
    pub fn new(input: &'a [u8], limits: IrLimits) -> Self {
        let mut parser = wasmparser::Parser::new(0);
        parser.set_features(super::features());
        Self {
            payloads: Box::new(parser.parse_all(input)),
            validator: wasmparser::Validator::new_with_features(super::features()),
            allocations: Default::default(),
            limits,
            finished: false,
        }
    }

    fn next_body(&mut self) -> Result<Option<FunctionIr<'a>>> {
        for payload in self.payloads.by_ref() {
            let payload = payload?;
            if let Payload::Version { encoding, .. } = payload {
                ensure!(
                    encoding == wasmparser::Encoding::Module,
                    "expected a core module"
                );
            }
            match self.validator.payload(&payload)? {
                ValidPayload::Func(resources, body) => {
                    ensure!(
                        body.range().len() <= self.limits.body_bytes,
                        "function IR source exceeds body budget"
                    );
                    let function = resources.index;
                    let type_index = resources.ty;
                    let mut validator =
                        resources.into_validator(std::mem::take(&mut self.allocations));
                    let ir = decode(
                        function,
                        type_index,
                        body,
                        &mut validator,
                        self.limits,
                        None,
                    )?;
                    self.allocations = validator.into_allocations();
                    return Ok(Some(ir));
                }
                ValidPayload::End(_) => {
                    self.finished = true;
                    return Ok(None);
                }
                ValidPayload::Parser(_) => anyhow::bail!("nested modules are not supported"),
                ValidPayload::Ok => {}
            }
        }
        ensure!(self.finished, "missing module end");
        Ok(None)
    }
}

impl<'a> Iterator for FunctionBodies<'a> {
    type Item = Result<FunctionIr<'a>>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }
        match self.next_body() {
            Ok(Some(body)) => Some(Ok(body)),
            Ok(None) => None,
            Err(error) => {
                self.finished = true;
                Some(Err(error))
            }
        }
    }
}

fn decode<'a>(
    function: u32,
    type_index: u32,
    body: wasmparser::FunctionBody<'a>,
    validator: &mut wasmparser::FuncValidator<wasmparser::ValidatorResources>,
    limits: IrLimits,
    instructions: Option<usize>,
) -> Result<FunctionIr<'a>> {
    let instruction_count = if let Some(count) = instructions {
        count
    } else {
        let mut reader = body.get_operators_reader()?;
        let mut count = 0;
        while !reader.eof() {
            ensure!(
                count < limits.instructions,
                "function IR exceeds instruction budget"
            );
            reader.read()?;
            count += 1;
        }
        count
    };
    ensure!(
        instruction_count <= limits.instructions,
        "function IR exceeds instruction budget"
    );
    let mut local_count = u64::from(validator.len_locals());
    for local in body.get_locals_reader()? {
        local_count = local_count
            .checked_add(u64::from(local?.0))
            .context("local count overflow")?;
        ensure!(
            local_count <= limits.locals as u64,
            "function IR exceeds local budget"
        );
    }
    validator.read_locals(&mut body.get_binary_reader())?;
    ensure!(
        validator.len_locals() as usize <= limits.locals,
        "function IR exceeds local budget"
    );
    let locals = (0..validator.len_locals())
        .map(|i| validator.get_local_type(i).unwrap())
        .collect();
    let mut out = FunctionIr {
        function,
        type_index,
        source: body.clone(),
        locals,
        // WHY exact reservation: repeated geometrically grown large IR
        // vectors leave freed backing pages resident on system allocators.
        // The scan already counted operators; the standalone iterator uses a
        // bounded count-only pass. Neither needs an instruction cache.
        instructions: Vec::with_capacity(instruction_count),
        regions: vec![Region {
            kind: RegionKind::Function,
            signature: BlockType::FuncType(type_index),
            parent: None,
            opener: None,
            end: 0,
            alternative: None,
            handlers: Vec::new(),
            delegate: None,
            operand_base: 0,
            input_stack: Vec::new(),
        }],
        transfers: Vec::new(),
        calls: Vec::new(),
    };
    let mut stack = vec![(RegionId(0), true)];
    let mut stack_values = 0usize;
    let mut branch_targets = 0usize;
    let mut reader = body.get_operators_reader()?;
    let mut retention = super::LexicalRetention::new(limits.instructions.saturating_add(1))?;
    while !reader.eof() {
        ensure!(
            out.instructions.len() < instruction_count,
            "function IR operator count exceeds validated summary"
        );
        let index = out.instructions.len();
        let offset = reader.original_position();
        let operation = reader.read()?;
        let retained = retention.visit(&operation)?;
        let (region, attached) = *stack.last().context("operator after function end")?;
        let reachable = attached
            && validator
                .get_control_frame(0)
                .is_some_and(|f| !f.unreachable);
        let call = matches!(
            operation,
            Operator::Call { .. }
                | Operator::CallIndirect { .. }
                | Operator::CallRef { .. }
                | Operator::ReturnCall { .. }
                | Operator::ReturnCallIndirect { .. }
                | Operator::ReturnCallRef { .. }
        );
        if call {
            let height = validator.operand_stack_height() as usize;
            stack_values = stack_values
                .checked_add(height)
                .context("landing stack size overflow")?;
            ensure!(
                stack_values <= limits.landing_stack_values,
                "function IR exceeds landing-stack budget"
            );
            let operand_stack = (0..height)
                .rev()
                .map(|depth| validator.get_operand_type(depth).flatten())
                .collect();
            out.calls.push(TypedCall {
                instruction: index,
                operand_base: validator.get_control_frame(0).unwrap().height,
                operand_stack,
            });
        }
        let opening = match &operation {
            Operator::Block { blockty } => Some((RegionKind::Block, *blockty)),
            Operator::Loop { blockty } => Some((RegionKind::Loop, *blockty)),
            Operator::If { blockty } => Some((RegionKind::If, *blockty)),
            Operator::Try { blockty } => Some((RegionKind::LegacyTry, *blockty)),
            Operator::TryTable { try_table } => Some((RegionKind::TryTable, try_table.ty)),
            _ => None,
        };
        let mut input_stack = Vec::new();
        if opening.is_some() {
            let height = validator.operand_stack_height() as usize;
            let floor = validator.get_control_frame(0).unwrap().height;
            let count = height
                .checked_sub(floor)
                .context("region operand stack below control floor")?;
            stack_values = stack_values
                .checked_add(count)
                .context("region input size overflow")?;
            ensure!(
                stack_values <= limits.landing_stack_values,
                "function IR exceeds landing-stack budget"
            );
            input_stack = (0..count)
                .rev()
                .map(|depth| validator.get_operand_type(depth).flatten())
                .collect();
        }
        let arity = operation.operator_arity(validator);
        let operand_height = validator.operand_stack_height();
        validator.op(offset, &operation)?;
        let target = |depth: u32, frames: &[(RegionId, bool)]| -> Result<RegionId> {
            frames
                .len()
                .checked_sub(depth as usize + 1)
                .map(|i| frames[i].0)
                .context("invalid source label depth")
        };
        let mut opens = None;
        if let Some((kind, signature)) = opening {
            let mut handlers = Vec::new();
            if let Operator::TryTable { try_table } = &operation {
                for (ordinal, catch) in try_table.catches.iter().enumerate() {
                    let (kind, tag, depth) = match *catch {
                        Catch::One { tag, label } => (HandlerKind::Catch, Some(tag), label),
                        Catch::OneRef { tag, label } => (HandlerKind::CatchRef, Some(tag), label),
                        Catch::All { label } => (HandlerKind::CatchAll, None, label),
                        Catch::AllRef { label } => (HandlerKind::CatchAllRef, None, label),
                    };
                    handlers.push(Handler {
                        ordinal,
                        kind,
                        tag,
                        target: Some(target(depth, &stack)?),
                        instruction: index,
                    });
                }
            }
            let id = RegionId(out.regions.len());
            out.regions.push(Region {
                kind,
                signature,
                parent: Some(region),
                opener: Some(index),
                end: 0,
                alternative: None,
                handlers,
                delegate: None,
                operand_base: validator.get_control_frame(0).unwrap().height,
                input_stack,
            });
            stack.push((id, reachable));
            opens = Some(id);
        }
        let transfer = match &operation {
            Operator::Br { relative_depth } => {
                Some((TransferKind::Branch, vec![target(*relative_depth, &stack)?]))
            }
            Operator::BrIf { relative_depth }
            | Operator::BrOnNull { relative_depth }
            | Operator::BrOnNonNull { relative_depth }
            | Operator::BrOnCast { relative_depth, .. }
            | Operator::BrOnCastFail { relative_depth, .. } => Some((
                TransferKind::Conditional,
                vec![target(*relative_depth, &stack)?],
            )),
            Operator::BrTable { targets } => {
                let count = targets.len() as usize + 1;
                ensure!(
                    count <= limits.branch_targets.saturating_sub(branch_targets),
                    "function IR exceeds branch-target budget"
                );
                let mut labels = Vec::with_capacity(count);
                for depth in targets.targets() {
                    labels.push(target(depth?, &stack)?);
                }
                labels.push(target(targets.default(), &stack)?);
                Some((TransferKind::Table, labels))
            }
            Operator::Return
            | Operator::ReturnCall { .. }
            | Operator::ReturnCallIndirect { .. }
            | Operator::ReturnCallRef { .. } => Some((TransferKind::Return, vec![RegionId(0)])),
            Operator::Rethrow { relative_depth } => Some((
                TransferKind::Rethrow,
                vec![target(*relative_depth, &stack)?],
            )),
            _ => None,
        };
        if let Some((kind, targets)) = transfer {
            branch_targets = branch_targets
                .checked_add(targets.len())
                .context("branch-target count overflow")?;
            ensure!(
                branch_targets <= limits.branch_targets,
                "function IR exceeds branch-target budget"
            );
            out.transfers.push(Transfer {
                instruction: index,
                kind,
                targets,
            });
        }
        match operation {
            Operator::Else => out.regions[region.0].alternative = Some(index),
            Operator::Catch { tag_index } => {
                let r = &mut out.regions[region.0];
                r.handlers.push(Handler {
                    ordinal: r.handlers.len(),
                    kind: HandlerKind::Catch,
                    tag: Some(tag_index),
                    target: None,
                    instruction: index,
                });
            }
            Operator::CatchAll => {
                let r = &mut out.regions[region.0];
                r.handlers.push(Handler {
                    ordinal: r.handlers.len(),
                    kind: HandlerKind::CatchAll,
                    tag: None,
                    target: None,
                    instruction: index,
                });
            }
            Operator::End => {
                out.regions[region.0].end = index;
                stack.pop();
            }
            Operator::Delegate { relative_depth } => {
                stack.pop();
                out.regions[region.0].delegate = Some(target(relative_depth, &stack)?);
                out.regions[region.0].end = index;
            }
            _ => {}
        }
        out.instructions.push(SourceInstruction {
            point: ProgramPoint { function, offset },
            operation,
            region,
            opens,
            reachable,
            retained,
            arity,
            operand_height,
        });
    }
    ensure!(
        stack.is_empty() && validator.control_stack_height() == 0,
        "function IR is missing its final end"
    );
    ensure!(
        out.instructions.len() == instruction_count,
        "function IR operator count differs from validated summary"
    );
    reader.finish()?;
    Ok(out)
}
