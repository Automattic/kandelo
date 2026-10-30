use super::model::{InputSpec, Inputs, Policy, ReadSet};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path};
use std::process::Command;

pub fn sha(bytes: &[u8]) -> String {
    crate::util::hex(&Sha256::digest(bytes))
}

pub fn file_sha(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut hash = Sha256::new();
    let mut buf = [0; 65536];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(crate::util::hex(&hash.finalize()))
}

pub fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into());
    }
    String::from_utf8(output.stdout).map_err(|e| e.to_string())
}

pub fn relative(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.contains('\\')
        || path.contains('\n')
        || path.contains('\r')
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || path
            .split('/')
            .any(|c| c.is_empty() || c == "." || c == "..")
    {
        return Err(format!(
            "expected a normalized repository-relative path: {path:?}"
        ));
    }
    Ok(())
}

pub fn excluded(path: &str, policy: &Policy) -> bool {
    policy.exclude.iter().any(|p| {
        if p.ends_with('/') {
            path.starts_with(p)
        } else {
            path == p
        }
    })
}

pub fn check_reads(
    suite: &str,
    host: &str,
    command: &[String],
    policy: &Policy,
    reads: &ReadSet,
) -> Result<(), String> {
    for path in &policy.exclude {
        relative(path.trim_end_matches('/'))?;
    }
    if !reads.complete
        || reads.suite != suite
        || reads.host != host
        || reads.command != command
        || reads.method.trim().is_empty()
        || reads.paths.is_empty()
    {
        return Err("read evidence must cover this entire suite, host and exact command (including child processes and file reads, not just imports)".into());
    }
    crate::util::hex_to_32(&reads.trace_sha256)?;
    for path in &reads.paths {
        relative(path)?;
        if excluded(path, policy) {
            return Err(format!(
                "suite reads excluded path {path}; remove that exclusion and recapture inputs"
            ));
        }
    }
    Ok(())
}

/// Git tree/blob IDs, not commit IDs. The recursive projection only expands
/// top-level trees containing an exclusion, so ordinary snapshots stay small.
pub fn source_components(root: &Path, policy: &Policy) -> Result<BTreeMap<String, String>, String> {
    for path in &policy.exclude {
        relative(path.trim_end_matches('/'))?;
    }
    let mut components = BTreeMap::new();
    for entry in git(root, &["ls-tree", "-z", "HEAD"])?
        .split('\0')
        .filter(|s| !s.is_empty())
    {
        let (identity, path) = entry.split_once('\t').ok_or("invalid git ls-tree entry")?;
        if excluded(path, policy) || excluded(&format!("{path}/"), policy) {
            continue;
        }
        let affected = policy
            .exclude
            .iter()
            .any(|p| p.starts_with(&format!("{path}/")));
        let value = if affected {
            let entries = git(root, &["ls-tree", "-rz", "HEAD", "--", path])?;
            let mut filtered = Vec::new();
            for entry in entries.split('\0').filter(|s| !s.is_empty()) {
                let (_, name) = entry
                    .split_once('\t')
                    .ok_or("invalid recursive git entry")?;
                if !excluded(name, policy) {
                    filtered.extend_from_slice(entry.as_bytes());
                    filtered.push(0);
                }
            }
            format!("filtered-sha256:{}", sha(&filtered))
        } else {
            identity.to_string()
        };
        components.insert(format!("git:{path}"), value);
    }
    Ok(components)
}

fn tree_hash(path: &Path, depth: usize) -> Result<String, String> {
    if depth > 32 {
        return Err(format!(
            "artifact tree/symlink depth exceeded: {}",
            path.display()
        ));
    }
    let metadata = fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if metadata.is_file() {
        return file_sha(path);
    }
    if !metadata.is_dir() {
        return Err(format!(
            "not an artifact file/directory: {}",
            path.display()
        ));
    }
    let mut entries = fs::read_dir(path)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    entries.sort_by_key(|e| e.file_name());
    let mut data = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        let name = name.to_str().ok_or("non-UTF8 artifact name")?;
        data.extend_from_slice(name.as_bytes());
        data.push(0);
        data.extend_from_slice(tree_hash(&entry.path(), depth + 1)?.as_bytes());
        data.push(0);
    }
    Ok(sha(&data))
}

pub fn json_file(path: &Path) -> Result<Value, String> {
    serde_json::from_slice(&fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?)
        .map_err(|e| format!("{}: {e}", path.display()))
}

fn require_sha(value: &Value, key: &str) -> Result<String, String> {
    let value = value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing {key} in projection"))?;
    crate::util::hex_to_32(value)?;
    Ok(value.into())
}

fn projection_components(
    root: &Path,
    spec: &InputSpec,
) -> Result<BTreeMap<String, String>, String> {
    let projection = json_file(&root.join(&spec.projection))?;
    let index = json_file(&root.join(&spec.program_index))?;
    if projection["format"] != "kandelo-source-only-program-projection-v1"
        || index["format"] != "kandelo-program-packages-v2"
        || projection["projection"] != index
    {
        return Err(
            "source-only projection and program index disagree or have unsupported formats".into(),
        );
    }
    let mut out = BTreeMap::new();
    out.insert(
        "artifact:program-index".into(),
        sha(&serde_json::to_vec(&index).map_err(|e| e.to_string())?),
    );
    out.insert(
        "artifact:projection-authority".into(),
        require_sha(&projection, "graphAuthoritySha256")?,
    );
    let nodes = projection["nodes"]
        .as_array()
        .filter(|a| !a.is_empty())
        .ok_or("projection has no nodes")?;
    let mirror_root = Path::new(&spec.program_index)
        .parent()
        .ok_or("program index has no parent")?;
    for node in nodes {
        let name = node["node"]["name"].as_str().ok_or("node has no name")?;
        let arch = node["node"]["targetArch"]
            .as_str()
            .ok_or("node has no arch")?;
        // Reuse the build engine's closure-derived keys and cache receipts;
        // never invent an independent package-input calculation here.
        for key in ["manifestSha256", "cacheKeySha256", "cacheReceiptSha256"] {
            out.insert(
                format!("artifact:projection:{name}:{arch}:{key}"),
                require_sha(node, key)?,
            );
        }
        let members = node["members"]
            .as_array()
            .ok_or("projection node has no members")?;
        for member in members {
            let member: crate::build_deps::MaterializedProgramMemberV1 =
                serde_json::from_value(member.clone()).map_err(|e| e.to_string())?;
            relative(&member.mirror_path)?;
            let path = root.join(mirror_root).join(&member.mirror_path);
            if file_sha(&path)? != member.sha256
                || fs::metadata(&path).map_err(|e| e.to_string())?.len() != member.size
            {
                return Err(format!(
                    "projected member differs from its build receipt: {}",
                    path.display()
                ));
            }
        }
    }
    Ok(out)
}

pub fn snapshot(
    root: &Path,
    spec: &InputSpec,
    versions: &BTreeMap<String, String>,
) -> Result<Inputs, String> {
    for path in spec
        .policy
        .exclude
        .iter()
        .map(|p| p.trim_end_matches('/'))
        .chain(std::iter::once(spec.kernel.as_str()))
        .chain(std::iter::once(spec.projection.as_str()))
        .chain(std::iter::once(spec.program_index.as_str()))
        .chain(spec.sysroots.iter().map(String::as_str))
        .chain(spec.extra_artifacts.iter().map(String::as_str))
    {
        relative(path)?;
    }
    if spec.sysroots.is_empty() {
        return Err("at least one consumed sysroot is required".into());
    }
    if !git(root, &["status", "--porcelain", "--untracked-files=normal"])?
        .trim()
        .is_empty()
    {
        return Err("input capture requires a clean worktree, including untracked files; use .context for run output".into());
    }
    let mut components = source_components(root, &spec.policy)?;
    let kernel = fs::read(root.join(&spec.kernel)).map_err(|e| e.to_string())?;
    let key = crate::build_stamp::read_build_key(&kernel)?
        .ok_or("kernel has no closure-derived build key")?;
    components.insert("artifact:kernel-cache-key".into(), crate::util::hex(&key));
    components.insert("artifact:kernel-bytes".into(), sha(&kernel));
    for sysroot in &spec.sysroots {
        // Hash installed bytes as well as the input stamp: a receipt alone
        // cannot detect an archive copied over a correctly stamped sysroot.
        file_sha(&root.join(sysroot).join(".kandelo-musl.input-hash"))?;
        file_sha(&root.join(sysroot).join(".kandelo-musl.outputs.json"))?;
        components.insert(
            format!("artifact:sysroot:{sysroot}"),
            tree_hash(&root.join(sysroot), 0)?,
        );
    }
    components.extend(projection_components(root, spec)?);
    for path in &spec.extra_artifacts {
        components.insert(
            format!("artifact:extra:{path}"),
            tree_hash(&root.join(path), 0)?,
        );
    }
    let mut read_files = BTreeMap::new();
    for path in &spec.read_paths {
        relative(path)?;
        if excluded(path, &spec.policy) {
            return Err(format!("read path {path} is excluded"));
        }
        let absolute = root.join(path);
        let value = match fs::metadata(&absolute) {
            Ok(meta) if meta.is_file() => file_sha(&absolute)?,
            Ok(meta) if meta.is_dir() => {
                let mut names = fs::read_dir(&absolute)
                    .map_err(|e| e.to_string())?
                    .map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned()))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                names.sort();
                sha(&serde_json::to_vec(&names).map_err(|e| e.to_string())?)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => "absent".into(),
            _ => return Err(format!("cannot fingerprint read path {path}")),
        };
        read_files.insert(path, value);
    }
    components.insert(
        "read-files".into(),
        sha(&serde_json::to_vec(&read_files).map_err(|e| e.to_string())?),
    );
    for (key, value) in versions {
        components.insert(format!("environment:{key}"), value.clone());
    }
    for (key, value) in &spec.context {
        components.insert(format!("context:{key}"), value.clone());
    }
    components.insert(
        "policy".into(),
        sha(&serde_json::to_vec(&spec.policy).map_err(|e| e.to_string())?),
    );
    let digest = sha(&serde_json::to_vec(&components).map_err(|e| e.to_string())?);
    Ok(Inputs {
        digest,
        tree: git(root, &["rev-parse", "HEAD^{tree}"])?.trim().into(),
        components,
        spec: spec.clone(),
    })
}

pub fn changed_paths(root: &Path, old: &Inputs, new: &Inputs) -> Result<Vec<String>, String> {
    let files = git(root, &["diff", "--name-only", "-z", &old.tree, &new.tree])?;
    let mut paths = files
        .split('\0')
        .filter(|p| !p.is_empty() && !excluded(p, &old.spec.policy))
        .map(str::to_string)
        .collect::<Vec<_>>();
    for key in old.components.keys().chain(new.components.keys()) {
        if !key.starts_with("git:") && old.components.get(key) != new.components.get(key) {
            paths.push(key.clone());
        }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

pub fn probe_versions(root: &Path, host: &str) -> Result<BTreeMap<String, String>, String> {
    let mut versions = BTreeMap::new();
    let output = |program: &str, args: &[&str], dir: &Path| -> Result<String, String> {
        let out = Command::new(program)
            .args(args)
            .current_dir(dir)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!(
                "version probe failed: {program}: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().into())
    };
    versions.insert("os".into(), output("uname", &["-srm"], root)?);
    if cfg!(target_os = "macos") {
        versions.insert(
            "os-release".into(),
            output("sw_vers", &["-productVersion"], root)?,
        );
    }
    versions.insert("node".into(), output("node", &["--version"], root)?);
    // The CI-shaped Vitest command also runs JSC checks under Bun. Keeping
    // its version even on conformance captures is conservative and avoids
    // treating a changed secondary runtime as equivalent evidence.
    versions.insert("bun".into(), output("bun", &["--version"], root)?);
    if host != "node" {
        let script = format!(
            "const p=require('playwright'); console.log(JSON.stringify({{playwright:require('playwright/package.json').version,browser:await (async()=>{{const b=await p.{host}.launch({{headless:true}}); try{{return b.version()}}finally{{await b.close()}}}})()}}))"
        );
        let result: BTreeMap<String, String> = serde_json::from_str(&output(
            "node",
            &[
                "--input-type=commonjs",
                "-e",
                &format!(
                    "(async()=>{{{script}}})().catch(e=>{{console.error(e);process.exit(1)}})"
                ),
            ],
            &root.join("apps/browser-demos"),
        )?)
        .map_err(|e| e.to_string())?;
        versions.extend(result);
    }
    Ok(versions)
}
