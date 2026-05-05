//! Assemble a single release bundle for one program.
//!
//! Produces `<program>-<upstream_version>-rev<revision>-<short-sha>.zip`
//! (or `.wasm` for the kernel/userspace case) in the output directory.
//! The zip contains the wasm binary and any runtime data files the
//! program needs, plus a LICENSE file copied from the program's
//! upstream source tree when we can find it.
//!
//! Usage:
//!   cargo xtask bundle-program \
//!       --program vim \
//!       --upstream-version 9.1.0900 \
//!       --revision 1 \
//!       --binary examples/libs/vim/bin/vim.wasm \
//!       --runtime-root examples/libs/vim/runtime \
//!       --runtime-prefix usr/share/vim/vim91 \
//!       --license examples/libs/vim/vim-src/LICENSE \
//!       --out-dir /tmp/release-staging
//!
//! For a bare program (no runtime) omit `--runtime-root`. For the
//! kernel / userspace case use `--plain-wasm` to skip zip packaging
//! and just copy + rename the input file with a short hash suffix.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::build_deps::{programs_by_name, Registry};
use crate::repo_root;

pub fn run(args: Vec<String>) -> Result<(), String> {
    let mut program: Option<String> = None;
    let mut upstream_version: Option<String> = None;
    let mut revision: Option<u32> = None;
    let mut binary: Option<PathBuf> = None;
    let mut runtime_root: Option<PathBuf> = None;
    let mut runtime_prefix: Option<String> = None;
    let mut license: Option<PathBuf> = None;
    let mut out_dir: Option<PathBuf> = None;
    let mut plain_wasm = false;
    let mut extra_files: Vec<(PathBuf, String)> = Vec::new();

    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--program" => program = Some(it.next().ok_or("--program requires a value")?),
            "--upstream-version" => {
                upstream_version = Some(it.next().ok_or("--upstream-version requires a value")?)
            }
            "--revision" => {
                revision = Some(
                    it.next()
                        .ok_or("--revision requires an integer")?
                        .parse()
                        .map_err(|e| format!("--revision: {e}"))?,
                )
            }
            "--binary" => binary = Some(it.next().ok_or("--binary requires a path")?.into()),
            "--runtime-root" => {
                runtime_root = Some(it.next().ok_or("--runtime-root requires a path")?.into())
            }
            "--runtime-prefix" => {
                runtime_prefix = Some(it.next().ok_or("--runtime-prefix requires a value")?)
            }
            "--license" => license = Some(it.next().ok_or("--license requires a path")?.into()),
            "--out-dir" => out_dir = Some(it.next().ok_or("--out-dir requires a path")?.into()),
            "--plain-wasm" => plain_wasm = true,
            "--extra-file" => {
                // --extra-file src=dest-inside-zip
                let s = it.next().ok_or("--extra-file requires src=dest")?;
                let (src, dest) = s
                    .split_once('=')
                    .ok_or_else(|| format!("--extra-file arg {s:?} lacks '='"))?;
                extra_files.push((src.into(), dest.into()));
            }
            other => return Err(format!("unknown arg {other:?}")),
        }
    }

    let program = program.ok_or("--program is required")?;
    let binary = binary.ok_or("--binary is required")?;
    let out_dir = out_dir.ok_or("--out-dir is required")?;

    // Sanity: there must be a per-dir manifest with kind = "program"
    // for this name so build-manifest can decorate it later.
    let registry = Registry::from_env(&repo_root());
    let progs = programs_by_name(&registry)?;
    if !progs.contains_key(&program) {
        return Err(format!(
            "program {program:?} has no examples/libs/{program}/package.toml \
             with kind = \"program\" — add a manifest before bundling"
        ));
    }

    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("mkdir {}: {e}", out_dir.display()))?;

    if plain_wasm {
        return bundle_plain_wasm(
            &program,
            upstream_version.as_deref(),
            revision,
            &binary,
            &out_dir,
        );
    }

    // Zip bundle path.
    let upstream_version = upstream_version.ok_or(
        "non-plain bundles require --upstream-version (or pass --plain-wasm for raw wasm)",
    )?;
    let revision = revision.unwrap_or(1);

    // Build the zip into a temp file first, then rename to final
    // hash-suffixed name once we know its content hash.
    let tmp_path = out_dir.join(format!(".bundle-{program}.tmp.zip"));
    {
        let tmp_file = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("create {}: {e}", tmp_path.display()))?;
        let mut writer = zip::ZipWriter::new(tmp_file);
        let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);

        // 1. The binary itself.
        let binary_bytes = std::fs::read(&binary)
            .map_err(|e| format!("read {}: {e}", binary.display()))?;
        let binary_name_in_zip = binary
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| format!("non-utf8 binary name: {}", binary.display()))?;
        writer
            .start_file(binary_name_in_zip, options)
            .map_err(|e| format!("zip start binary: {e}"))?;
        writer
            .write_all(&binary_bytes)
            .map_err(|e| format!("zip write binary: {e}"))?;

        // 2. Runtime files, if any.
        if let Some(root) = runtime_root.as_deref() {
            let prefix = runtime_prefix.as_deref().unwrap_or("");
            add_tree(&mut writer, root, prefix, options)?;
        }

        // 3. LICENSE file, if provided.
        if let Some(l) = license.as_deref() {
            let lic_bytes = std::fs::read(l)
                .map_err(|e| format!("read {}: {e}", l.display()))?;
            writer
                .start_file("LICENSE", options)
                .map_err(|e| format!("zip start LICENSE: {e}"))?;
            writer
                .write_all(&lic_bytes)
                .map_err(|e| format!("zip write LICENSE: {e}"))?;
        }

        // 4. Extra files the caller specified.
        for (src, dest) in &extra_files {
            let bytes = std::fs::read(src)
                .map_err(|e| format!("read {}: {e}", src.display()))?;
            writer
                .start_file(dest.as_str(), options)
                .map_err(|e| format!("zip start {dest}: {e}"))?;
            writer
                .write_all(&bytes)
                .map_err(|e| format!("zip write {dest}: {e}"))?;
        }

        writer
            .finish()
            .map_err(|e| format!("zip finish: {e}"))?;
    }

    let final_bytes = std::fs::read(&tmp_path)
        .map_err(|e| format!("read tmp: {e}"))?;
    let mut hasher = Sha256::new();
    hasher.update(&final_bytes);
    let short_hash = hex_short(&hasher.finalize());

    let final_name = format!(
        "{program}-{upstream_version}-rev{revision}-{short_hash}.zip"
    );
    let final_path = out_dir.join(&final_name);
    std::fs::rename(&tmp_path, &final_path)
        .map_err(|e| format!("rename {} -> {}: {e}", tmp_path.display(), final_path.display()))?;

    println!("wrote {}", final_path.display());
    Ok(())
}

fn bundle_plain_wasm(
    program: &str,
    upstream_version: Option<&str>,
    revision: Option<u32>,
    binary: &Path,
    out_dir: &Path,
) -> Result<(), String> {
    let bytes = std::fs::read(binary)
        .map_err(|e| format!("read {}: {e}", binary.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let short = hex_short(&hasher.finalize());
    let ext = binary
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("wasm");
    let out_name = match (upstream_version, revision) {
        (Some(v), Some(r)) => format!("{program}-{v}-rev{r}-{short}.{ext}"),
        (Some(v), None)    => format!("{program}-{v}-rev1-{short}.{ext}"),
        _                  => format!("{program}-{short}.{ext}"),
    };
    let out_path = out_dir.join(&out_name);
    std::fs::copy(binary, &out_path)
        .map_err(|e| format!("copy {} -> {}: {e}", binary.display(), out_path.display()))?;
    println!("wrote {}", out_path.display());
    Ok(())
}

fn add_tree(
    writer: &mut zip::ZipWriter<std::fs::File>,
    root: &Path,
    prefix_in_zip: &str,
    options: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    // Collect into a Vec + sort for deterministic order.
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).map_err(|e| format!("read {}: {e}", dir.display()))? {
            let entry = entry.map_err(|e| format!("read_dir entry: {e}"))?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() {
                let rel = path
                    .strip_prefix(root)
                    .map_err(|_| format!("strip_prefix {}", path.display()))?
                    .to_string_lossy()
                    .into_owned();
                let dest = if prefix_in_zip.is_empty() {
                    rel
                } else {
                    format!("{}/{}", prefix_in_zip.trim_end_matches('/'), rel)
                };
                files.push((path, dest));
            }
        }
    }
    files.sort_by(|a, b| a.1.cmp(&b.1));

    for (src, dest) in files {
        let mut f = std::fs::File::open(&src)
            .map_err(|e| format!("open {}: {e}", src.display()))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)
            .map_err(|e| format!("read {}: {e}", src.display()))?;
        writer
            .start_file(dest.as_str(), options)
            .map_err(|e| format!("zip start {dest}: {e}"))?;
        writer
            .write_all(&buf)
            .map_err(|e| format!("zip write {dest}: {e}"))?;
    }
    Ok(())
}

fn hex_short(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(8);
    for b in bytes.iter().take(4) {
        write!(&mut s, "{b:02x}").unwrap();
    }
    s
}
