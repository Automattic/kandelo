//! Controlled comparisons of separate phases and complete fork transforms.
//! Each measurement runs in a fresh process against the same exact input.

use anyhow::{Context, Result, ensure};
use fork_instrument::{call_graph, facts, sink as oracle_sink, streaming::*};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    borrow::Cow,
    collections::BTreeSet,
    io::Write,
    path::Path,
    sync::atomic::{AtomicUsize, Ordering},
};
use wasm_encoder::reencode::Reencode;
#[path = "memory_comparison/facts.rs"]
mod facts_inspection;
#[path = "memory_comparison/full.rs"]
mod full;
#[path = "memory_comparison/shapes.rs"]
mod shapes;

struct CountingAllocator;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn allocated(size: usize) {
    let live = LIVE.fetch_add(size, Ordering::Relaxed) + size;
    PEAK.fetch_max(live, Ordering::Relaxed);
}

// This example counts requested Rust allocation bytes on both paths. OS
// physical footprint below also includes allocator overhead and non-Rust pages.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            allocated(layout.size());
        }
        pointer
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            allocated(layout.size());
        }
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }
    unsafe fn realloc(&self, pointer: *mut u8, old: Layout, size: usize) -> *mut u8 {
        let result = unsafe { System.realloc(pointer, old, size) };
        if !result.is_null() {
            if size >= old.size() {
                allocated(size - old.size());
            } else {
                LIVE.fetch_sub(old.size() - size, Ordering::Relaxed);
            }
        }
        result
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

#[cfg(target_os = "macos")]
fn physical_peak() -> Result<u64> {
    // rusage_info_v4 from the macOS SDK sys/resource.h: UUID followed by 35
    // u64 fields; field 28 is ri_lifetime_max_phys_footprint. This is the OS
    // lifetime high-water mark, so a short-lived peak is not missed by polling.
    #[repr(C)]
    struct Usage {
        uuid: [u8; 16],
        values: [u64; 35],
    }
    #[link(name = "proc")]
    unsafe extern "C" {
        fn proc_pid_rusage(pid: i32, flavor: i32, output: *mut Usage) -> i32;
    }
    let mut usage = Usage {
        uuid: [0; 16],
        values: [0; 35],
    };
    let result = unsafe { proc_pid_rusage(std::process::id() as i32, 4, &mut usage) };
    ensure!(
        result == 0,
        "proc_pid_rusage: {}",
        std::io::Error::last_os_error()
    );
    Ok(usage.values[28])
}

#[cfg(not(target_os = "macos"))]
fn physical_peak() -> Result<u64> {
    anyhow::bail!("physical-footprint measurement requires macOS")
}

fn hash_words(words: impl IntoIterator<Item = u32>) -> u64 {
    words.into_iter().fold(0xcbf29ce484222325u64, |hash, word| {
        word.to_le_bytes()
            .iter()
            .fold(hash, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x100000001b3))
    })
}

fn binding_hash(bindings: &[(u32, Vec<(usize, usize)>)]) -> u64 {
    let mut words = Vec::new();
    for (function, pairs) in bindings {
        words.extend([*function, pairs.len() as u32]);
        for &(chunk, definition) in pairs {
            words.extend([chunk as u32, definition as u32]);
        }
    }
    hash_words(words)
}

fn measure(backend: &str, phase: &str, path: &Path) -> Result<()> {
    let input = std::fs::read(path)?;
    let mut binding = 0;
    let mut boundaries = BTreeSet::new();
    let mut returning = BTreeSet::new();
    let (activations, control, functions, nodes, output_bytes);
    match backend {
        "eager" => {
            let mut module = walrus::Module::from_buffer(&input)?;
            let taken = facts::take_section(&mut module);
            let seeds = call_graph::find_import_funcs(&module, "kernel.kernel_fork");
            let mut closure = call_graph::analyze_reaching_closure_from_seeds(
                &module,
                seeds.iter().copied(),
                false,
            );
            if phase == "sinks" {
                ensure!(
                    seeds.len() == 1,
                    "sink benchmark requires exactly one fork seed"
                );
                let call_facts = taken
                    .as_ref()
                    .map(|taken| -> Result<_> {
                        facts::verify_code_hash(taken, &input)?;
                        Ok(facts::call_facts(&module, &taken.section, Default::default())?.0)
                    })
                    .transpose()?;
                let plan = oracle_sink::plan_with_facts(
                    &module,
                    seeds[0],
                    &closure,
                    Default::default(),
                    call_facts.as_ref(),
                )
                .context("oracle sink plan unavailable")?;
                closure.activations = plan.activations;
                closure.control_reachable = plan.control_reachable;
                boundaries.extend(plan.boundaries.into_iter().map(|f| f.index() as u32));
                returning.extend(plan.fork_returning.into_iter().map(|f| f.index() as u32));
                std::hint::black_box(&call_facts);
            }
            activations = closure
                .activations
                .iter()
                .map(|f| f.index() as u32)
                .collect::<BTreeSet<_>>();
            control = closure
                .control_reachable
                .iter()
                .map(|f| f.index() as u32)
                .collect::<BTreeSet<_>>();
            functions = module.funcs.iter_local().count();
            nodes = module
                .funcs
                .iter_local()
                .map(|(_, local)| local.size())
                .sum::<u64>();
            if phase != "sinks"
                && let Some(taken) = taken
            {
                facts::verify_code_hash(&taken, &input)?;
                binding = binding_hash(&facts::binding(&module, &taken.section)?);
            }
            if phase == "roundtrip" {
                let bytes = module.emit_wasm();
                let mut file = tempfile::tempfile()?;
                file.write_all(&bytes)?;
                output_bytes = bytes.len() as u64;
                std::hint::black_box(&bytes);
            } else {
                output_bytes = 0;
            }
            std::hint::black_box(&module);
        }
        "stream" => {
            let scanned = scan(&input)?;
            let seeds: Vec<_> = scanned
                .functions
                .iter()
                .enumerate()
                .filter_map(|(i, f)| {
                    f.import
                        .as_ref()
                        .filter(|(m, n)| m == "kernel" && n == "kernel_fork")
                        .map(|_| i as u32)
                })
                .collect();
            let mut closure = scanned.reaching_from_seeds(seeds.iter().copied(), false)?;
            if phase == "sinks" {
                ensure!(
                    seeds.len() == 1,
                    "sink benchmark requires exactly one fork seed"
                );
                let mut store = if scanned.custom_data(facts::SECTION).next().is_some() {
                    let store =
                        facts::storage::FactsStore::from_scan(&scanned, Default::default())?;
                    store.resolve_calls(&scanned, Default::default())?;
                    store
                } else {
                    facts::storage::FactsStore::empty(Default::default())?
                };
                let mut program = sink::Program::build(&scanned, &mut store, Default::default())?;
                let plan = sink::plan_sinks(
                    &mut program,
                    seeds[0],
                    &closure,
                    Default::default(),
                    Default::default(),
                )?
                .context("native sink plan unavailable")?;
                closure.activations = plan.activations;
                closure.control_reachable = plan.control_reachable;
                boundaries = plan.boundaries;
                returning = plan.fork_returning;
                std::hint::black_box(&program);
            }
            activations = closure.activations;
            control = closure.control_reachable;
            functions = scanned.functions.len() - scanned.imported_functions as usize;
            if phase != "sinks" && scanned.custom_data(facts::SECTION).next().is_some() {
                binding = binding_hash(&scanned.bind_fact_definitions()?);
            }
            if phase == "roundtrip" {
                struct Native {
                    nodes: u64,
                }
                impl Reencode for Native {
                    type Error = std::convert::Infallible;
                }
                impl FunctionTransform for Native {
                    fn function_ir_limits(&self) -> Option<IrLimits> {
                        Some(IrLimits::default())
                    }
                    fn transform_ir(
                        &mut self,
                        ir: &FunctionIr<'_>,
                        limit: usize,
                    ) -> Result<wasm_encoder::Function> {
                        self.nodes += ir.instructions.len() as u64;
                        ir.emit(self, limit)
                    }
                }
                let mut native = Native { nodes: 0 };
                let mut file = tempfile::tempfile()?;
                emit_remapped(&scanned, &mut native, &mut file, EmitLimits::default())?;
                output_bytes = file.metadata()?.len();
                nodes = native.nodes;
            } else if phase != "sinks" {
                let mut count = 0;
                for body in FunctionBodies::new(&input, IrLimits::default()) {
                    let body = body?;
                    count += body.instructions.len() as u64;
                    std::hint::black_box(&body);
                }
                nodes = count;
                output_bytes = 0;
            } else {
                nodes = scanned.operators;
                output_bytes = 0;
            }
            std::hint::black_box(&scanned);
        }
        _ => anyhow::bail!("backend must be eager or stream"),
    }
    let heap = PEAK.load(Ordering::Relaxed);
    let physical = physical_peak()?;
    println!(
        "{{\"backend\":\"{backend}\",\"phase\":\"{phase}\",\"input_bytes\":{},\"functions\":{functions},\"ir_nodes\":{nodes},\"activations\":{},\"control\":{},\"activation_hash\":{},\"control_hash\":{},\"boundaries\":{},\"boundary_hash\":{},\"fork_returning\":{},\"returning_hash\":{},\"binding_hash\":{binding},\"output_bytes\":{output_bytes},\"rust_requested_peak_bytes\":{heap},\"physical_lifetime_peak_bytes\":{physical}}}",
        input.len(),
        activations.len(),
        control.len(),
        hash_words(activations),
        hash_words(control),
        boundaries.len(),
        hash_words(boundaries),
        returning.len(),
        hash_words(returning)
    );
    Ok(())
}

fn arithmetic(
    functions: u32,
    repetitions: u32,
    data_bytes: usize,
    facts_edges: usize,
    fork_mode: bool,
) -> Result<Vec<u8>> {
    use wasm_encoder::*;
    let mut module = Module::new();
    let mut types = TypeSection::new();
    types.ty().function([], [ValType::I32]);
    if fork_mode {
        types.ty().function([ValType::I32], [ValType::I32]);
    }
    module.section(&types);
    let mut imports = ImportSection::new();
    imports.import(
        "kernel",
        "kernel_fork",
        EntityType::Function(u32::from(fork_mode)),
    );
    module.section(&imports);
    let mut declarations = FunctionSection::new();
    for _ in 0..functions {
        declarations.function(0);
    }
    module.section(&declarations);
    if data_bytes != 0 {
        let mut memories = MemorySection::new();
        memories.memory(MemoryType {
            minimum: data_bytes.div_ceil(65536) as u64,
            maximum: None,
            memory64: false,
            shared: false,
            page_size_log2: None,
        });
        module.section(&memories);
    }
    let mut code = CodeSection::new();
    for _ in 0..functions {
        let mut function = Function::new([]);
        for _ in 0..repetitions {
            function
                .instruction(&Instruction::I32Const(1))
                .instruction(&Instruction::I32Const(2))
                .instruction(&Instruction::I32Add)
                .instruction(&Instruction::Drop);
        }
        if fork_mode {
            function.instruction(&Instruction::I32Const(0));
        }
        function
            .instruction(&Instruction::Call(0))
            .instruction(&Instruction::End);
        code.function(&function);
    }
    module.section(&code);
    if data_bytes != 0 {
        let mut data = DataSection::new();
        data.active(
            0,
            &ConstExpr::i32_const(0),
            std::iter::repeat_n(42, data_bytes),
        );
        module.section(&data);
    }
    let mut names = NameSection::new();
    let mut map = NameMap::new();
    for i in 1..=functions {
        map.append(i, &format!("f{i}"));
    }
    names.functions(&map);
    module.section(&names);
    let mut bytes = module.finish();
    if facts_edges != 0 {
        let mut text = String::from("#kandelo-calltypes\t5\nM\tcontrolled.c\n");
        for i in 1..=functions {
            use std::fmt::Write;
            writeln!(text, "F\tf{i}\t0\nD\tf{i}\t0\t0")?;
        }
        for i in 0..facts_edges {
            use std::fmt::Write;
            writeln!(text, "SE\tp:f1:{i}\tl:f1:{i}")?;
        }
        let hash = facts::code_sha256(&bytes)?;
        for (name, data) in [
            (facts::SECTION, text.as_bytes()),
            (facts::CODE_HASH_SECTION, hash.as_slice()),
        ] {
            bytes.push(0);
            CustomSection {
                name: Cow::Borrowed(name),
                data: Cow::Borrowed(data),
            }
            .encode(&mut bytes);
        }
    }
    Ok(bytes)
}

fn generate(directory: &Path) -> Result<()> {
    std::fs::create_dir_all(directory)?;
    for (name, functions, repetitions, data, edges) in [
        ("arithmetic-wide", 1024, 512, 0, 0),
        ("many-tiny", 50_000, 0, 0, 0),
        ("one-large", 1, 128_000, 0, 0),
        ("facts-heavy", 1000, 4, 0, 250_000),
        ("data-heavy", 1000, 4, 16 * 1024 * 1024, 0),
    ] {
        let bytes = arithmetic(functions, repetitions, data, edges, false)?;
        scan(&bytes).with_context(|| format!("validate generated {name}"))?;
        std::fs::write(directory.join(format!("{name}.wasm")), bytes)?;
    }
    let nested = wat::parse_str(include_str!(
        "../tests/fixtures/determinism/multiple_nested_regions.wat"
    ))?;
    std::fs::write(directory.join("nested-regression.wasm"), nested)?;
    Ok(())
}

fn generate_sinks(directory: &Path) -> Result<()> {
    std::fs::create_dir_all(directory)?;
    for (name, functions, repetitions, data, edges) in [
        ("arithmetic-wide", 512, 512, 0, 0),
        ("many-tiny", 8000, 0, 0, 0),
        ("one-large", 1, 32_000, 0, 0),
        ("facts-heavy", 256, 4, 0, 50_000),
        ("data-heavy", 256, 4, 8 * 1024 * 1024, 0),
    ] {
        let bytes = arithmetic(functions, repetitions, data, edges, true)?;
        scan(&bytes).with_context(|| format!("validate generated {name}"))?;
        std::fs::write(directory.join(format!("{name}.wasm")), bytes)?;
    }
    for (name, handler) in [
        ("child-exit", "unreachable"),
        ("caught-child", "i32.const 1 throw $t"),
    ] {
        let bytes = wat::parse_str(format!(
            r#"(module
          (import "kernel" "kernel_fork" (func $seed (param i32) (result i32)))
          (tag $t (param i32))
          (func $fork (result i32) i32.const 0 call $seed)
          (func $spawn (result i32) (local i32) call $fork local.tee 0
            i32.eqz if {handler} end local.get 0)
          (func $root (export "root") (result i32)
            block $handler (result i32)
              try_table (result i32) (catch $t $handler) call $spawn end
              return
            end drop i32.const 42))"#
        ))?;
        std::fs::write(directory.join(format!("{name}.wasm")), bytes)?;
    }
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("generate") if args.len() == 3 => generate(Path::new(&args[2])),
        Some("generate-sinks") if args.len() == 3 => generate_sinks(Path::new(&args[2])),
        Some("facts") if args.len() == 4 => {
            let disk_bytes = args[3].parse::<u64>()?;
            facts_inspection::inspect(Path::new(&args[2]), disk_bytes)
        }
        Some("shapes") if args.len() == 3 => shapes::inspect(Path::new(&args[2])),
        Some("measure") if args.len() == 5 => {
            ensure!(
                matches!(args[3].as_str(), "frontend" | "roundtrip" | "sinks"),
                "invalid phase"
            );
            measure(&args[2], &args[3], Path::new(&args[4]))
        }
        Some("measure") if args.len() == 6 && args[3] == "instrument" => {
            full::measure(&args[2], Path::new(&args[4]), Path::new(&args[5]))
        }
        Some("validate") if args.len() == 3 => {
            scan(&std::fs::read(&args[2])?)?;
            Ok(())
        }
        _ => anyhow::bail!(concat!(
            "usage: memory_comparison generate|generate-sinks DIR | shapes INPUT | ",
            "facts INPUT DB_BYTES | measure eager|stream frontend|roundtrip|sinks INPUT | ",
            "measure eager|stream instrument INPUT OUTPUT | validate INPUT",
        )),
    }
}
