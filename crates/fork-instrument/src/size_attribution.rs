//! Opt-in byte attribution for generated fork instrumentation.
//!
//! Building with `--features size-attribution` and setting
//! `WPK_FORK_SIZE_ATTRIBUTION=<path>` makes the instrumenter write one TSV row
//! per emitted function: which emitter produced each output byte, plus the
//! per-function shape counts (fork-reaching call sites, saved scalars) that
//! explain how the bytes scale. Without the feature every entry point here is
//! an inline no-op and generated instructions keep the default location, so
//! default builds emit byte-identical modules.
//!
//! WHY this design: walrus already maps every instruction's `InstrLocId` to
//! its output offset when `preserve_code_transform` is set. Tagging generated
//! instructions with a unique location that names their emitter turns that map
//! into an exact per-category byte count, including the `end`/`else` bytes
//! that close generated blocks. A post-hoc pattern matcher over the output
//! would have to re-derive every emitted shape and drift as the shapes change.

use walrus::ir::InstrLocId;

/// The emitter that produced a generated instruction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u8)]
pub enum Category {
    /// Generated with no enclosing scope; a gap in attribution coverage.
    Untagged = 0,
    /// Original instruction, first emitted copy.
    Original,
    /// Original instruction emitted again (duplicated arms or replayed
    /// pure tails).
    OriginalDuplicate,
    /// Entry `state >= REWINDING` test around the replay preamble.
    EntryGuard,
    /// `frame_next` call and active-frame store in the replay preamble.
    PreambleFrameNext,
    /// Per-scalar restores in the replay preamble.
    PreambleRestoreScalars,
    /// Reference-recipe restores in the replay preamble.
    PreambleRestoreReferences,
    /// Catch selector and scalar catch payload restores.
    PreambleCatch,
    /// Abort-restart loop and the function-level unwind block.
    RestartLoop,
    /// Replay dispatch heads: state tests and call-index loads.
    Dispatch,
    /// Replay dispatch `br_table` instructions.
    DispatchTable,
    /// Cascading POST landing blocks and the normal-path `return`.
    DispatchPost,
    /// Per-call result/catch blocks and the private-tag `try_table`.
    CallBoundary,
    /// Per-call frame-size/call-index/select call and its branch pair.
    CallUnwindSelect,
    /// Per-call `state >= REWINDING` arm split and the replay arm contents.
    CallReplayRoute,
    /// Stores of call arguments and operand carryovers at a landing.
    ArgSpill,
    /// Reloads of call arguments and operand carryovers at a landing.
    ArgReload,
    /// Nested `IfElse` condition rewrite through `select`.
    NestedCond,
    /// Multi-value structured-control parameter pre-spill and reload.
    BodyParams,
    /// Frame header stores in the postamble.
    PostambleHeader,
    /// Per-scalar saves in the postamble.
    PostambleSaveScalars,
    /// Reference-recipe saves in the postamble.
    PostambleSaveReferences,
    /// Catch scalar payload saves in the postamble.
    PostambleCatch,
    /// Frame commit and private-tag throw.
    PostambleCommitThrow,
    /// Tagged-catch capture blocks.
    CatchCapture,
    /// Tagged-catch rewind rethrow stubs.
    CatchRewindStub,
    /// Private-tag shield around user `catch_all`.
    Shield,
    /// Shadow-stack scratch reserve/release/copies.
    Scratch,
    /// Legacy exception-handling normalization.
    LegacyEh,
    /// Generated helper functions (resume thunks, transport helpers, ...).
    Helper,
}

impl Category {
    pub const ALL: [Category; 30] = [
        Category::Untagged,
        Category::Original,
        Category::OriginalDuplicate,
        Category::EntryGuard,
        Category::PreambleFrameNext,
        Category::PreambleRestoreScalars,
        Category::PreambleRestoreReferences,
        Category::PreambleCatch,
        Category::RestartLoop,
        Category::Dispatch,
        Category::DispatchTable,
        Category::DispatchPost,
        Category::CallBoundary,
        Category::CallUnwindSelect,
        Category::CallReplayRoute,
        Category::ArgSpill,
        Category::ArgReload,
        Category::NestedCond,
        Category::BodyParams,
        Category::PostambleHeader,
        Category::PostambleSaveScalars,
        Category::PostambleSaveReferences,
        Category::PostambleCatch,
        Category::PostambleCommitThrow,
        Category::CatchCapture,
        Category::CatchRewindStub,
        Category::Shield,
        Category::Scratch,
        Category::LegacyEh,
        Category::Helper,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Category::Untagged => "untagged",
            Category::Original => "original",
            Category::OriginalDuplicate => "original_dup",
            Category::EntryGuard => "entry_guard",
            Category::PreambleFrameNext => "pre_frame_next",
            Category::PreambleRestoreScalars => "pre_restore_scalars",
            Category::PreambleRestoreReferences => "pre_restore_refs",
            Category::PreambleCatch => "pre_catch",
            Category::RestartLoop => "restart_loop",
            Category::Dispatch => "dispatch_head",
            Category::DispatchTable => "dispatch_table",
            Category::DispatchPost => "dispatch_post",
            Category::CallBoundary => "call_boundary",
            Category::CallUnwindSelect => "call_unwind_select",
            Category::CallReplayRoute => "call_replay_route",
            Category::ArgSpill => "arg_spill",
            Category::ArgReload => "arg_reload",
            Category::NestedCond => "nested_cond",
            Category::BodyParams => "body_params",
            Category::PostambleHeader => "post_header",
            Category::PostambleSaveScalars => "post_save_scalars",
            Category::PostambleSaveReferences => "post_save_refs",
            Category::PostambleCatch => "post_catch",
            Category::PostambleCommitThrow => "post_commit_throw",
            Category::CatchCapture => "catch_capture",
            Category::CatchRewindStub => "catch_rewind_stub",
            Category::Shield => "shield",
            Category::Scratch => "scratch",
            Category::LegacyEh => "legacy_eh",
            Category::Helper => "helper",
        }
    }
}

/// Shape counts recorded by the per-function transform.
#[derive(Debug, Clone, Copy, Default)]
pub struct FunctionShape {
    pub call_sites: u32,
    pub direct_activation_sites: u32,
    pub saved_scalars: u32,
    pub frame_size: u32,
    pub nested: bool,
    pub scratch: bool,
    pub regions: u32,
}

#[cfg(not(feature = "size-attribution"))]
mod imp {
    use super::{Category, FunctionShape, InstrLocId};

    pub struct Scope;

    #[inline(always)]
    pub fn scope(_category: Category) -> Scope {
        Scope
    }

    #[inline(always)]
    pub fn generated_loc() -> InstrLocId {
        InstrLocId::default()
    }

    #[inline(always)]
    pub fn record_shape(_function: walrus::FunctionId, _shape: FunctionShape) {}

    #[inline(always)]
    pub fn enabled() -> bool {
        false
    }
}

#[cfg(feature = "size-attribution")]
mod imp {
    use super::{Category, FunctionShape, InstrLocId};
    use std::cell::{Cell, RefCell};
    use std::collections::{HashMap, HashSet};

    /// Generated locations start above any plausible input byte offset.
    pub(super) const GENERATED_BASE: u32 = 0x8000_0000;

    thread_local! {
        static CURRENT: Cell<Category> = const { Cell::new(Category::Untagged) };
        pub(super) static TAGS: RefCell<Vec<Category>> = const { RefCell::new(Vec::new()) };
        pub(super) static SHAPES: RefCell<HashMap<walrus::FunctionId, FunctionShape>> =
            RefCell::new(HashMap::new());
        pub(super) static INSTRUMENTED: RefCell<HashSet<walrus::FunctionId>> =
            RefCell::new(HashSet::new());
    }

    pub struct Scope(Category);

    impl Drop for Scope {
        fn drop(&mut self) {
            CURRENT.with(|current| current.set(self.0));
        }
    }

    pub fn scope(category: Category) -> Scope {
        Scope(CURRENT.with(|current| current.replace(category)))
    }

    pub fn generated_loc() -> InstrLocId {
        let category = CURRENT.with(Cell::get);
        TAGS.with(|tags| {
            let mut tags = tags.borrow_mut();
            let id = GENERATED_BASE + tags.len() as u32;
            tags.push(category);
            InstrLocId::new(id)
        })
    }

    pub fn record_shape(function: walrus::FunctionId, shape: FunctionShape) {
        SHAPES.with(|shapes| shapes.borrow_mut().insert(function, shape));
        INSTRUMENTED.with(|set| set.borrow_mut().insert(function));
    }

    pub fn enabled() -> bool {
        std::env::var_os("WPK_FORK_SIZE_ATTRIBUTION").is_some()
    }
}

pub use imp::{Scope, enabled, generated_loc, record_shape, scope};

#[cfg(feature = "size-attribution")]
pub use report::{emit_with_report, parse_for_report};

#[cfg(feature = "size-attribution")]
mod report {
    use super::imp::{GENERATED_BASE, INSTRUMENTED, SHAPES, TAGS};
    use super::{Category, FunctionShape};
    use anyhow::{Context, Result};
    use std::borrow::Cow;
    use std::collections::{HashMap, HashSet};
    use std::fmt::Write as _;
    use std::sync::Mutex;
    use walrus::ir::{Instr, InstrLocId, InstrSeqId};
    use walrus::{CodeTransform, CustomSection, FunctionId, FunctionKind, IdsToIndices, Module};

    static TRANSFORM: Mutex<
        Option<(
            Vec<(InstrLocId, usize)>,
            Vec<(FunctionId, std::ops::Range<usize>)>,
        )>,
    > = Mutex::new(None);

    #[derive(Debug)]
    struct CaptureTransform;

    impl CustomSection for CaptureTransform {
        fn name(&self) -> &str {
            "kandelo.size_attribution"
        }

        fn data(&self, _: &IdsToIndices) -> Cow<'_, [u8]> {
            Cow::Borrowed(&[])
        }

        fn apply_code_transform(&mut self, transform: &CodeTransform) {
            *TRANSFORM.lock().unwrap() = Some((
                transform.instruction_map.clone(),
                transform.function_ranges.clone(),
            ));
        }
    }

    /// Parse with walrus's code-transform map enabled.
    pub fn parse_for_report(input: &[u8]) -> Result<Module> {
        let mut config = walrus::ModuleConfig::new();
        config.preserve_code_transform(true);
        config.parse(input)
    }

    fn input_body_sizes(input: &[u8]) -> Result<Vec<usize>> {
        let mut sizes = Vec::new();
        for payload in wasmparser::Parser::new(0).parse_all(input) {
            if let wasmparser::Payload::CodeSectionEntry(body) = payload? {
                sizes.push(body.range().len());
            }
        }
        Ok(sizes)
    }

    /// Retag every instruction with a unique location naming its category,
    /// emit, and write the per-function attribution TSV to `path`.
    pub fn emit_with_report(
        module: &mut Module,
        input: &[u8],
        original_locals: &[FunctionId],
        path: &std::path::Path,
    ) -> Result<Vec<u8>> {
        let input_sizes = input_body_sizes(input)?;
        let input_size: HashMap<FunctionId, usize> = original_locals
            .iter()
            .copied()
            .zip(input_sizes.iter().copied())
            .collect();
        let original_set: HashSet<FunctionId> = original_locals.iter().copied().collect();

        // Final category per unique location id.
        let mut categories: Vec<Category> = Vec::new();
        let tags = TAGS.with(|tags| tags.borrow().clone());
        let function_ids: Vec<FunctionId> = module.funcs.iter().map(|f| f.id()).collect();
        for id in &function_ids {
            let helper = !original_set.contains(id);
            let FunctionKind::Local(local) = &mut module.funcs.get_mut(*id).kind else {
                continue;
            };
            let mut seen = HashSet::new();
            let mut stack: Vec<InstrSeqId> = vec![local.entry_block()];
            let mut visited = HashSet::new();
            while let Some(seq) = stack.pop() {
                if !visited.insert(seq) {
                    continue;
                }
                let block = local.block_mut(seq);
                // walrus also maps each sequence's `end` location; original
                // ones are input offsets that would collide with the unique
                // ids assigned below. `end` bytes are attributed through the
                // control stack instead.
                block.end = InstrLocId::default();
                let mut children = Vec::new();
                for (instr, loc) in block.instrs.iter_mut() {
                    let category = if helper {
                        Category::Helper
                    } else if loc.is_default() {
                        Category::Untagged
                    } else if loc.data() >= GENERATED_BASE {
                        tags[(loc.data() - GENERATED_BASE) as usize]
                    } else if seen.insert(loc.data()) {
                        Category::Original
                    } else {
                        Category::OriginalDuplicate
                    };
                    *loc = InstrLocId::new(categories.len() as u32);
                    categories.push(category);
                    children.extend(nested(instr));
                }
                stack.extend(children);
            }
        }

        module.customs.add(CaptureTransform);
        let output = module.emit_wasm();
        let (instruction_map, function_ranges) = TRANSFORM
            .lock()
            .unwrap()
            .take()
            .context("walrus did not report a code transform")?;
        let by_offset: HashMap<usize, Category> = instruction_map
            .iter()
            .map(|(loc, offset)| (*offset, categories[loc.data() as usize]))
            .collect();

        let shapes = SHAPES.with(|shapes| shapes.borrow().clone());
        let instrumented = INSTRUMENTED.with(|set| set.borrow().clone());
        let dump = std::env::var("WPK_FORK_SIZE_ATTRIBUTION_DUMP").ok();
        let mut tsv = String::new();
        write!(
            tsv,
            "kind\tname\tinput_bytes\toutput_bytes\tcall_sites\tdirect_sites\tsaved_scalars\tframe_size\tnested_fn\tscratch_fn\tregions\tlocals_decl"
        )?;
        for category in Category::ALL {
            write!(tsv, "\t{}", category.label())?;
        }
        tsv.push('\n');

        for (id, range) in function_ranges {
            let body = &output[range.clone()];
            let mut reader = wasmparser::BinaryReader::new(body, range.start);
            let body_len = reader.read_var_u32()? as usize;
            let body_start = reader.original_position();
            let function_body = wasmparser::FunctionBody::new(wasmparser::BinaryReader::new(
                &output[body_start..body_start + body_len],
                body_start,
            ));
            let mut bytes = vec![0usize; Category::ALL.len()];
            let mut locals = function_body.get_locals_reader()?;
            for _ in 0..locals.get_count() {
                locals.read()?;
            }
            let ops_start = locals.original_position();
            let locals_decl = ops_start - body_start;
            let mut ops = function_body.get_operators_reader()?;
            let mut control: Vec<Category> = Vec::new();
            let mut pending: Option<(usize, Category)> = None;
            while !ops.eof() {
                let offset = ops.original_position();
                let op = ops.read()?;
                if let Some((start, category)) = pending.take() {
                    bytes[category as usize] += offset - start;
                }
                use wasmparser::Operator as O;
                let category = match op {
                    O::End | O::Else | O::Delegate { .. } | O::Catch { .. } | O::CatchAll => {
                        // Closing bytes belong to the construct they close;
                        // the function's own final `end` is original.
                        let category = control.last().copied().unwrap_or(Category::Original);
                        if matches!(op, O::End | O::Delegate { .. }) {
                            control.pop();
                        }
                        category
                    }
                    _ => by_offset
                        .get(&offset)
                        .copied()
                        .unwrap_or(Category::Untagged),
                };
                if matches!(
                    op,
                    O::Block { .. }
                        | O::Loop { .. }
                        | O::If { .. }
                        | O::TryTable { .. }
                        | O::Try { .. }
                ) {
                    control.push(category);
                }
                if dump.is_some() && dump.as_deref() == module.funcs.get(id).name.as_deref() {
                    eprintln!("{offset}\t{}\t{op:?}", category.label());
                }
                pending = Some((offset, category));
            }
            if let Some((start, category)) = pending.take() {
                bytes[category as usize] += ops.original_position() - start;
            }

            let function = module.funcs.get(id);
            let kind = if instrumented.contains(&id) {
                "instrumented"
            } else if original_set.contains(&id) {
                "original"
            } else {
                "helper"
            };
            let shape = shapes.get(&id).copied().unwrap_or(FunctionShape::default());
            let name = function
                .name
                .clone()
                .unwrap_or_else(|| format!("{id:?}"))
                .replace(['\t', '\n'], " ");
            write!(
                tsv,
                "{kind}\t{name}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{locals_decl}",
                input_size.get(&id).copied().unwrap_or(0),
                range.len(),
                shape.call_sites,
                shape.direct_activation_sites,
                shape.saved_scalars,
                shape.frame_size,
                u8::from(shape.nested),
                u8::from(shape.scratch),
                shape.regions,
            )?;
            for value in bytes {
                write!(tsv, "\t{value}")?;
            }
            tsv.push('\n');
        }
        std::fs::write(path, tsv)
            .with_context(|| format!("writing size attribution: {}", path.display()))?;
        Ok(output)
    }

    fn nested(instr: &Instr) -> Vec<InstrSeqId> {
        use walrus::ir::{Block, IfElse, LegacyCatch, Loop, TryTable};
        match instr {
            Instr::Block(Block { seq }) | Instr::Loop(Loop { seq }) => vec![*seq],
            Instr::IfElse(IfElse {
                consequent,
                alternative,
            }) => vec![*consequent, *alternative],
            Instr::TryTable(TryTable { seq, .. }) => vec![*seq],
            Instr::Try(t) => {
                let mut ids = vec![t.seq];
                for c in &t.catches {
                    match c {
                        LegacyCatch::Catch { handler, .. } | LegacyCatch::CatchAll { handler } => {
                            ids.push(*handler)
                        }
                        LegacyCatch::Delegate { .. } => {}
                    }
                }
                ids
            }
            _ => Vec::new(),
        }
    }
}
