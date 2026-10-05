//! Dev helper: check the in-crate facts analysis against the fork-sink
//! research results (`tools/fork-sink-research`), without an SDK that
//! embeds facts in objects.
//!
//! It takes a research link (`<base>.wasm`, `<base>.map`, `<base>.inputs`)
//! and the research side files, resolves each linked object to its side file
//! the way the research tool `fpa` did (link-time hashes, archive member
//! hashes, alias tables), concatenates them in the linker's input order into
//! a `kandelo.calltypes` section as wasm-ld would, appends that section to
//! the link, and runs the instrumenter's own sink decision on it. Reports:
//!
//! - the per-function binding by chunk order against `fpa`'s binding by the
//!   linker map;
//! - the instrumented set against a research `.set` file;
//! - the boundaries against the `SINK` rows of the research `fsa` report;
//! - with `--instrument`, that full instrumentation succeeds and removes the
//!   section.
//!
//! ```text
//! cargo run --release -p fork-instrument --example facts_equivalence --target <host> -- \
//!   --link .context/fpr2/shims/links/git-25173-1791074690 \
//!   --side-dir .context/fpr2/shims/side \
//!   --aliases .context/fpr2/runtime/aliases.tsv --aliases .context/fpr2/aliases-all.tsv \
//!   --set .context/fpr2/G-git-dlc.set --fsa .context/fpr2/G-git-dlc.fsa.txt \
//!   --assume-dlopen-contract [--instrument] [--no-facts] [--no-effective-types]
//! ```
//!
//! `--assume-dlopen-contract` reproduces the research runs (`DLC=1`), which
//! assume the not-yet-implemented load-time dlopen contract; without it the
//! instrumenter's own (sound, larger) treatment of dlopen-capable modules
//! applies. The link also gets the `kandelo.calltypes.code-sha256` section
//! the SDK writes, so the instrumenter's code-hash guard passes.
use anyhow::{Context, Result, bail};
use std::collections::{BTreeSet, HashMap};
use std::path::Path;

/// Members of an `ar` archive (GNU or BSD format): (name, bytes).
fn ar_members(path: &str) -> Vec<(String, Vec<u8>)> {
    let Ok(b) = std::fs::read(path) else { return vec![] };
    if !b.starts_with(b"!<arch>\n") {
        return vec![];
    }
    let mut out = vec![];
    let mut names: Vec<u8> = vec![];
    let mut off = 8;
    while off + 60 <= b.len() {
        let h = &b[off..off + 60];
        let field = |a: usize, z: usize| String::from_utf8_lossy(&h[a..z]).trim().to_string();
        let size: usize = field(48, 58).parse().unwrap_or(0);
        let mut data = off + 60;
        let raw = field(0, 16);
        let end = (data + size).min(b.len());
        let name = if raw == "//" {
            names = b[data..end].to_vec();
            String::new()
        } else if raw == "/" || raw == "/SYM64/" || raw.starts_with("__.SYMDEF") {
            String::new()
        } else if let Some(n) = raw.strip_prefix("#1/") {
            let n: usize = n.parse().unwrap_or(0);
            let nm = String::from_utf8_lossy(&b[data..data + n]).trim_end_matches('\0').to_string();
            data += n;
            nm
        } else if let Some(o) = raw.strip_prefix('/').and_then(|x| x.parse::<usize>().ok()) {
            let rest = &names[o.min(names.len())..];
            let e = rest.iter().position(|&c| c == b'\n').unwrap_or(rest.len());
            String::from_utf8_lossy(&rest[..e]).trim_end_matches('/').to_string()
        } else {
            raw.trim_end_matches('/').to_string()
        };
        if !name.is_empty() && !name.starts_with("__.SYMDEF") {
            out.push((name, b[data..end].to_vec()));
        }
        off = off + 60 + size;
        off += off % 2;
    }
    out
}

fn sha256_hex(b: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

/// The CODE entries of a wasm-ld map: (input file, symbol names).
fn map_code_entries(text: &str) -> Vec<(String, Vec<String>)> {
    let mut out: Vec<(String, Vec<String>)> = vec![];
    let mut in_code = false;
    for line in text.lines() {
        let t = line.trim_start();
        let cols: Vec<&str> = t.split_whitespace().take(3).collect();
        if cols.len() < 3 {
            continue;
        }
        let after = {
            let mut rest = t;
            for c in &cols {
                let p = rest.find(c).unwrap() + c.len();
                rest = &rest[p..];
            }
            rest
        };
        let gap = after.len() - after.trim_start().len();
        let item = after.trim_start();
        if gap == 1 {
            in_code = item == "CODE";
            continue;
        }
        if !in_code {
            continue;
        }
        if gap < 14 {
            match item.rfind(":(") {
                Some(p) => out.push((item[..p].to_string(), vec![item[p + 2..item.len().saturating_sub(1)].to_string()])),
                None => out.push((item.to_string(), vec![])),
            }
        } else if let Some(last) = out.last_mut() {
            last.1.push(item.to_string());
        }
    }
    out
}

/// fpa's resolution of one linked input to its side files.
struct Resolver {
    side_dir: String,
    loose: HashMap<String, Vec<String>>,
    aliases: HashMap<(String, String), Vec<String>>,
    ar_cache: HashMap<String, Vec<(String, String)>>,
}

impl Resolver {
    fn sides(&mut self, input: &str) -> Vec<String> {
        let exists = |p: &str| Path::new(p).exists();
        let base = |p: &str| p.rsplit('/').next().unwrap_or(p).to_string();
        if input.starts_with('<') {
            return vec![];
        }
        if let Some(hs) = self.loose.get(input) {
            let ps: Vec<String> = hs.iter().map(|h| format!("{}/{h}.calltypes", self.side_dir)).filter(|p| exists(p)).collect();
            if !ps.is_empty() {
                return ps;
            }
        }
        if let (true, Some(open)) = (input.ends_with(')'), input.rfind('(')) {
            let (ar, mem) = (&input[..open], &input[open + 1..input.len() - 1]);
            let members = self
                .ar_cache
                .entry(ar.to_string())
                .or_insert_with(|| ar_members(ar).into_iter().map(|(n, b)| (n, sha256_hex(&b))).collect());
            let exact: Vec<String> = members
                .iter()
                .filter(|(n, _)| n == mem)
                .map(|(_, h)| format!("{}/{h}.calltypes", self.side_dir))
                .filter(|p| exists(p))
                .collect();
            if !exact.is_empty() {
                return exact;
            }
            return self.aliases.get(&(base(ar), mem.to_string())).cloned().unwrap_or_default();
        }
        let b = base(input);
        for g in ["channel_syscall", "compiler_rt", "cxxrt", "dlopen"] {
            if b.starts_with(&format!("{g}-")) || b == format!("{g}.o") {
                if let Some(v) = self.aliases.get(&("glue".to_string(), g.to_string())) {
                    return v.clone();
                }
            }
        }
        self.aliases.get(&("loose".to_string(), b)).cloned().unwrap_or_default()
    }
}

/// (name, mangled) of each definition in a side file, in order.
fn side_defs(text: &str) -> Vec<(String, String)> {
    let mut out = vec![];
    for l in text.lines() {
        let f: Vec<&str> = l.split('\t').collect();
        if f[0] == "F" && f.len() >= 2 {
            out.push((f[1].to_string(), f.get(5).unwrap_or(&"").to_string()));
        }
    }
    out
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let get = |k: &str| args.iter().position(|a| a == k).map(|i| args[i + 1].clone());
    let all = |k: &str| -> Vec<String> { args.iter().enumerate().filter(|(_, a)| *a == k).map(|(i, _)| args[i + 1].clone()).collect() };
    let base = get("--link").context("--link <base>")?;
    let side_dir = get("--side-dir").context("--side-dir")?;
    let wasm = std::fs::read(format!("{base}.wasm"))?;
    let map = std::fs::read_to_string(format!("{base}.map"))?;
    let inputs = std::fs::read_to_string(format!("{base}.inputs")).unwrap_or_default();

    let mut loose: HashMap<String, Vec<String>> = HashMap::new();
    for l in inputs.lines() {
        let f: Vec<&str> = l.split('\t').collect();
        if f.len() >= 2 && f[1] != "-" {
            loose.entry(f[0].to_string()).or_default().push(f[1].to_string());
        }
    }
    let mut aliases: HashMap<(String, String), Vec<String>> = HashMap::new();
    for p in all("--aliases") {
        for l in std::fs::read_to_string(&p)?.lines() {
            let f: Vec<&str> = l.split('\t').collect();
            if f.len() == 3 {
                let v = if f[0] == "glue" || f[2].starts_with('/') { f[2].to_string() } else { format!("{side_dir}/{}.calltypes", f[2]) };
                let e = aliases.entry((f[0].to_string(), f[1].to_string())).or_default();
                if !e.contains(&v) {
                    e.push(v);
                }
            }
        }
    }
    let mut resolver = Resolver { side_dir: side_dir.clone(), loose, aliases, ar_cache: HashMap::new() };

    // Chunks in the linker's object order: each side file at the first map
    // CODE entry it describes. An input name can stand for several objects
    // (archive members with the same name), so a side file is placed where
    // a function it defines appears, not where its input name first does.
    let entries = map_code_entries(&map);
    let module = walrus::Module::from_buffer(&wasm)?;
    let mut locals: Vec<(u32, String)> = module
        .funcs
        .iter()
        .filter(|f| matches!(f.kind, walrus::FunctionKind::Local(_)))
        .map(|f| (f.id().index() as u32, f.name.clone().unwrap_or_default()))
        .collect();
    locals.sort();
    if locals.len() != entries.len() {
        bail!("map CODE entries {} vs defined functions {}", entries.len(), locals.len());
    }
    let mut sides_of: HashMap<String, Vec<String>> = HashMap::new();
    let mut text_of: HashMap<String, String> = HashMap::new();
    let mut names_of: HashMap<String, std::collections::HashSet<String>> = HashMap::new();
    let mut placed: Vec<String> = vec![];
    for (k, (input, syms)) in entries.iter().enumerate() {
        let sides = sides_of.entry(input.clone()).or_insert_with(|| resolver.sides(input)).clone();
        let mut names = vec![locals[k].1.clone()];
        names.extend(syms.iter().cloned());
        for sp in &sides {
            if !text_of.contains_key(sp) {
                let text = std::fs::read_to_string(sp).with_context(|| sp.clone())?;
                names_of.insert(sp.clone(), side_defs(&text).into_iter().flat_map(|(n, m)| [n, m]).collect());
                text_of.insert(sp.clone(), text);
            }
        }
        let hit = sides.iter().find(|sp| names.iter().any(|n| names_of[*sp].contains(n)));
        if let Some(sp) = hit {
            if !placed.contains(sp) {
                placed.push(sp.clone());
            }
        }
    }
    // Side files no function binds to (everything removed by the link) go
    // after their input's first placed sibling, or at the end.
    for (input, _) in &entries {
        for sp in &sides_of[input] {
            if !placed.contains(sp) {
                placed.push(sp.clone());
            }
        }
    }
    let mut chunk_paths: Vec<String> = vec![];
    let mut section: Vec<u8> = vec![];
    let mut texts: Vec<String> = vec![];
    for sp in &placed {
        let text = text_of[sp].clone();
        section.extend_from_slice(text.as_bytes());
        chunk_paths.push(sp.clone());
        texts.push(text);
    }
    let mut per_input: HashMap<String, Vec<usize>> = HashMap::new();
    for (input, sides) in &sides_of {
        per_input.insert(input.clone(), sides.iter().map(|sp| placed.iter().position(|p| p == sp).unwrap()).collect());
    }

    // Append the sections as the SDK's link emits them (custom sections
    // after the others): the facts, and the hash binding them to the code.
    let mut with = wasm.clone();
    let code_hash = fork_instrument::facts::code_sha256(&wasm)?;
    for (name, data) in [(fork_instrument::facts::SECTION, &section[..]), (fork_instrument::facts::CODE_HASH_SECTION, &code_hash[..])] {
        let mut content = vec![];
        leb(&mut content, name.len());
        content.extend_from_slice(name.as_bytes());
        content.extend_from_slice(data);
        with.push(0);
        leb(&mut with, content.len());
        with.extend_from_slice(&content);
    }
    println!("chunks\t{} ({} bytes)", chunk_paths.len(), section.len());

    // Binding: chunk order vs fpa's map binding.
    let chunk_bind = fork_instrument::facts::binding(&module, &section)?;
    let defs: Vec<Vec<(String, String)>> = texts.iter().map(|t| side_defs(t)).collect();
    let name_of = |f: u32| module.funcs.iter().find(|x| x.id().index() as u32 == f).and_then(|x| x.name.clone()).unwrap_or_default();
    // agree: bound to exactly fpa's definition; covers: bound to a union
    // that contains it; differ: a union or single binding without it.
    let (mut agree, mut covers, mut both_none, mut map_only, mut chunk_only, mut differ) = (0, 0, 0, 0, 0, 0);
    let mut examples: Vec<String> = vec![];
    for (k, (input, syms)) in entries.iter().enumerate() {
        let (f, cb) = &chunk_bind[k];
        let f = *f;
        let fname = name_of(f);
        let mut names = vec![fname.clone()];
        names.extend(syms.iter().cloned());
        // fpa: the map's section symbol is the mangled name (exact), else
        // the first definition named like the function.
        let mut mb: Option<(usize, usize)> = None;
        for &c in per_input.get(input).map(|v| v.as_slice()).unwrap_or(&[]) {
            let d = &defs[c];
            let hit = syms.first().and_then(|m| d.iter().position(|(_, mg)| mg == m)).or_else(|| d.iter().position(|(n, _)| names.contains(n)));
            if let Some(i) = hit {
                mb = Some((c, i));
                break;
            }
        }
        let fmt = |v: &[(usize, usize)]| v.iter().map(|b| format!("{}#{}", chunk_paths[b.0].rsplit('/').next().unwrap(), b.1)).collect::<Vec<_>>().join("+");
        match (mb, cb.as_slice()) {
            (Some(a), [b]) if a == *b => agree += 1,
            (Some(a), bs) if bs.len() > 1 && bs.contains(&a) => covers += 1,
            (None, []) => both_none += 1,
            (Some(a), []) => {
                map_only += 1;
                if examples.len() < 40 {
                    examples.push(format!("map-only\t{fname}\t{}#{}", chunk_paths[a.0].rsplit('/').next().unwrap(), a.1));
                }
            }
            (None, bs) => {
                chunk_only += 1;
                if examples.len() < 40 {
                    examples.push(format!("chunk-only\t{fname}\t{}", fmt(bs)));
                }
            }
            (Some(a), bs) => {
                differ += 1;
                if examples.len() < 40 {
                    examples.push(format!("differ\t{fname}\tmap {} chunk {}", fmt(&[a]), fmt(bs)));
                }
            }
        }
    }
    println!("binding\tagree {agree}\tunion-covers {covers}\tboth-unbound {both_none}\tmap-only {map_only}\tchunk-only {chunk_only}\tdiffer {differ}");
    for e in &examples {
        println!("  {e}");
    }

    if let Some(out) = get("--dump-facts") {
        // fpa's export format: <out> (itargets), <out>.cleanup, <out>.jmp.
        let (cf, _) = fork_instrument::facts::call_facts(&module, &section, Default::default())?;
        let mut t = String::new();
        for (f, sig, targets) in &cf.itargets {
            t.push_str(&format!("{f}\t{sig}\t{}\n", targets.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")));
        }
        std::fs::write(&out, t)?;
        let mut c = String::new();
        for (f, hs) in &cf.cleanup {
            c.push_str(&format!("{f}\t{}\n", hs.join("\u{1}")));
        }
        std::fs::write(format!("{out}.cleanup"), c)?;
        std::fs::write(format!("{out}.jmp"), cf.jmp.iter().map(|l| format!("{l}\n")).collect::<String>())?;
    }

    // The research results assume the dlopen contract; the instrumenter
    // does not (yet).
    let contract = args.iter().any(|a| a == "--assume-dlopen-contract");
    if args.iter().any(|a| a == "--raw") {
        // The sink analysis with facts on the raw link, outside the
        // instrumenter's pipeline (no legacy lowering, no closure filter).
        let (mut cf, _) = fork_instrument::facts::call_facts(&module, &section, Default::default())?;
        cf.assume_dlopen_contract = contract;
        let seed = fork_instrument::call_graph::find_import_func(&module, "kernel.kernel_fork").context("kernel_fork")?;
        let today = fork_instrument::call_graph::analyze_reaching_closure(&module, seed);
        let t0 = std::time::Instant::now();
        let plan = fork_instrument::sink::plan_with_facts(&module, seed, &today, Default::default(), Some(&cf)).context("plan")?;
        println!("raw\tplan {:.1}s", t0.elapsed().as_secs_f64());
        let set: BTreeSet<String> = plan.activations.iter().filter(|f| matches!(module.funcs.get(**f).kind, walrus::FunctionKind::Local(_))).map(|f| fork_instrument::call_graph::func_display_name(&module, *f)).collect();
        println!("raw\tinstrumented {}\tboundaries {}", set.len(), plan.boundaries.len());
        // Fork-returning functions a side module could call through the table.
        let mut in_table = std::collections::HashSet::new();
        for e in module.elements.iter() {
            match &e.items {
                walrus::ElementItems::Functions(v) => in_table.extend(v.iter().copied()),
                walrus::ElementItems::Expressions(_, ex) => in_table.extend(ex.iter().filter_map(|x| if let walrus::ConstExpr::RefFunc(f) = x { Some(*f) } else { None })),
            }
        }
        let mut fr: Vec<String> = plan.fork_returning.iter().filter(|f| in_table.contains(*f)).map(|f| fork_instrument::call_graph::func_display_name(&module, *f)).collect();
        fr.sort();
        println!("raw\tfork-returning {}\taddress-taken {:?}", plan.fork_returning.len(), fr);
        if args.iter().any(|a| a == "--only-raw") {
            return Ok(());
        }
    }

    // The instrumenter's own decision on the link with the section.
    let opts = fork_instrument::Options { side_modules: if contract { fork_instrument::SideModules::TracedEntries } else { fork_instrument::SideModules::AssumeAllEntriesForkReturning }, ..Default::default() };
    if contract {
        let r = fork_instrument::sink_report(&with, &fork_instrument::Options::default())?;
        println!("without-contract\tsource {}\tinstrumented {}\tboundaries {}", r.source.as_str(), r.instrumented.len(), r.boundaries.len());
    }
    let t0 = std::time::Instant::now();
    let report = fork_instrument::sink_report(&with, &opts)?;
    println!("source\t{}\t({:.1}s)", report.source.as_str(), t0.elapsed().as_secs_f64());
    if let Some(e) = &report.facts_error {
        println!("facts-error\t{e}");
    }
    if let Some(f) = &report.facts {
        println!("facts\t{f:?}");
    }
    let ours: BTreeSet<String> = report.instrumented.iter().cloned().collect();
    println!("instrumented\t{}", ours.len());
    if let Some(p) = get("--set") {
        let theirs: BTreeSet<String> = std::fs::read_to_string(&p)?.lines().filter(|l| !l.is_empty()).map(|l| l.to_string()).collect();
        let extra: Vec<&String> = ours.difference(&theirs).collect();
        let missing: Vec<&String> = theirs.difference(&ours).collect();
        println!("vs-research-set\t{}\tresearch {}\tonly-ours {}\tonly-research {}", p, theirs.len(), extra.len(), missing.len());
        for x in extra.iter().take(30) {
            println!("  only-ours\t{x}");
        }
        for x in missing.iter().take(30) {
            println!("  only-research\t{x}");
        }
    }
    if let Some(p) = get("--fsa") {
        let set: BTreeSet<String> = report.instrumented.iter().cloned().collect();
        let theirs: BTreeSet<String> = std::fs::read_to_string(&p)?
            .lines()
            .filter_map(|l| l.strip_prefix("SINK\t"))
            .filter_map(|l| l.split('\t').next())
            .filter(|n| set.contains(*n))
            .map(|s| s.to_string())
            .collect();
        let ours: BTreeSet<String> = report.boundaries.iter().cloned().collect();
        println!(
            "boundaries\tours {}\tresearch {}\tonly-ours {:?}\tonly-research {:?}",
            ours.len(),
            theirs.len(),
            ours.difference(&theirs).take(10).collect::<Vec<_>>(),
            theirs.difference(&ours).take(10).collect::<Vec<_>>()
        );
    }
    if args.iter().any(|a| a == "--no-effective-types") {
        let r = fork_instrument::sink_report(&with, &fork_instrument::Options { effective_types: false, ..opts.clone() })?;
        println!("no-effective-types\tsource {}\tinstrumented {}", r.source.as_str(), r.instrumented.len());
    }
    if args.iter().any(|a| a == "--no-facts") {
        let r = fork_instrument::sink_report(&with, &fork_instrument::Options { facts: false, ..opts.clone() })?;
        println!("no-facts\tsource {}\tinstrumented {}", r.source.as_str(), r.instrumented.len());
    }
    if args.iter().any(|a| a == "--instrument") {
        let t0 = std::time::Instant::now();
        let out = fork_instrument::instrument(&with, &opts)?;
        if let Some(path) = get("--out") {
            std::fs::write(&path, &out).with_context(|| format!("writing {path}"))?;
        }
        let has = wasmparser::Parser::new(0)
            .parse_all(&out)
            .filter_map(|p| p.ok())
            .any(|p| matches!(p, wasmparser::Payload::CustomSection(s) if s.name() == fork_instrument::facts::SECTION));
        println!("instrument\t{} -> {} bytes\tfacts section kept: {has}\t({:.1}s)", with.len(), out.len(), t0.elapsed().as_secs_f64());
        wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all()).validate_all(&out).context("validating instrumented output")?;
        println!("instrument\tvalid");
    }
    Ok(())
}

fn leb(out: &mut Vec<u8>, mut v: usize) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            break;
        }
        out.push(b | 0x80);
    }
}
