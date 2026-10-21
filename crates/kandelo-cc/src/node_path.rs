//! POSIX path arithmetic with Node.js `path` semantics.
//!
//! The driver's paths reach the compiler as argument text (`--sysroot=`,
//! `-fuse-ld=`, prefix maps, glue sources), so their spelling is part of
//! what a build produces. These functions spell paths exactly as the
//! TypeScript driver this crate replaced did, so switching drivers changed
//! no compiler command.

/// Normalize `path`, resolving `.` and `..` segments lexically.
fn normalize_string(path: &str, allow_above_root: bool) -> String {
    let mut segments: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if segments.last().is_some_and(|last| *last != "..") {
                    segments.pop();
                } else if allow_above_root {
                    segments.push("..");
                }
            }
            other => segments.push(other),
        }
    }
    segments.join("/")
}

pub fn is_absolute(path: &str) -> bool {
    path.starts_with('/')
}

/// `path.normalize`.
pub fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let absolute = is_absolute(path);
    let trailing = path.ends_with('/');
    let mut out = normalize_string(path, !absolute);
    if out.is_empty() {
        if absolute {
            return "/".into();
        }
        return if trailing { "./".into() } else { ".".into() };
    }
    if trailing {
        out.push('/');
    }
    if absolute {
        format!("/{out}")
    } else {
        out
    }
}

/// `path.join`.
pub fn join(parts: &[&str]) -> String {
    let joined: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    if joined.is_empty() {
        return ".".into();
    }
    normalize(&joined.join("/"))
}

/// `path.resolve(base, path)`, with `base` standing in for `process.cwd()`
/// when `path` is relative.
pub fn resolve(base: &str, path: &str) -> String {
    let combined = if is_absolute(path) {
        path.to_string()
    } else if path.is_empty() {
        base.to_string()
    } else {
        format!("{base}/{path}")
    };
    let out = normalize_string(&combined, !is_absolute(&combined));
    if is_absolute(&combined) {
        format!("/{out}")
    } else if out.is_empty() {
        ".".into()
    } else {
        out
    }
}

/// `path.basename`.
pub fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return "";
    }
    match trimmed.rfind('/') {
        Some(index) => &trimmed[index + 1..],
        None => trimmed,
    }
}

/// The process's working directory as Node's `process.cwd()` reports it.
pub fn cwd() -> String {
    std::env::current_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_node() {
        assert_eq!(join(&["/a/b/../glue", "x.c"]), "/a/glue/x.c");
        assert_eq!(join(&["/x//bin/", "wasm-ld"]), "/x/bin/wasm-ld");
        assert_eq!(join(&["a/", "b/"]), "a/b/");
        assert_eq!(join(&["/", ".."]), "/");
        assert_eq!(resolve("/w", "../x/./y/"), "/x/y");
        assert_eq!(resolve("/w", "/abs"), "/abs");
        assert_eq!(resolve("/w/", ""), "/w");
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(basename("clang.exe"), "clang.exe");
        assert_eq!(normalize("../a/.."), "..");
    }
}
