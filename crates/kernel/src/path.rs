extern crate alloc;
use alloc::vec::Vec;

/// Resolve a path against a working directory.
/// If path is absolute (starts with '/'), clean and return it.
/// If path is relative, prepend cwd + '/' and clean.
pub fn resolve_path(path: &[u8], cwd: &[u8]) -> Vec<u8> {
    if path.is_empty() {
        return Vec::new();
    }
    if path.first() == Some(&b'/') {
        return clean_path(path);
    }
    let mut resolved = cwd.to_vec();
    if resolved.last() != Some(&b'/') {
        resolved.push(b'/');
    }
    resolved.extend_from_slice(path);
    clean_path(&resolved)
}

/// Clean an absolute path without lexically resolving `..`.
///
/// POSIX pathname resolution is component-wise: an implementation must look up
/// an intermediate directory before a later `..` can step back out of it. For
/// example, `existing/missing/../file` fails with ENOENT because `missing` is
/// looked up first. Collapsing `missing/..` in this helper would incorrectly
/// bypass that lookup. Backends perform the real component walk, including
/// symlink and `..` handling.
///
/// This helper only removes redundant separators and `.` components so callers
/// still pass absolute paths to host backends.
/// The input path must be absolute (start with '/').
pub fn clean_path(path: &[u8]) -> Vec<u8> {
    let has_trailing_slash = path.len() > 1 && path.last() == Some(&b'/');
    let mut components: Vec<&[u8]> = Vec::new();

    for component in path.split(|&b| b == b'/') {
        match component {
            b"" | b"." => continue,
            _ => {
                components.push(component);
            }
        }
    }

    if components.is_empty() {
        return alloc::vec![b'/'];
    }

    let mut result = Vec::new();
    for component in &components {
        result.push(b'/');
        result.extend_from_slice(component);
    }
    if has_trailing_slash && result.len() > 1 {
        result.push(b'/');
    }
    result
}

/// Back-compat name for callers that want an absolute path string cleaned for
/// host I/O. This no longer collapses `..`; see [`clean_path`].
pub fn normalize_path(path: &[u8]) -> Vec<u8> {
    clean_path(path)
}

/// Collapse `.` and `..` components for an already-resolved existing path.
///
/// General pathname resolution must not do this before lookup, because
/// `missing/..` must still fail while resolving `missing`. After `chdir(2)`
/// has successfully validated the target directory, however, the process cwd
/// should be stored in canonical form so `getcwd(2)` does not report literal
/// `.` or `..` components.
pub fn canonicalize_existing_path(path: &[u8]) -> Vec<u8> {
    let mut components: Vec<&[u8]> = Vec::new();

    for component in path.split(|&b| b == b'/') {
        match component {
            b"" | b"." => {}
            b".." => {
                components.pop();
            }
            _ => components.push(component),
        }
    }

    if components.is_empty() {
        return alloc::vec![b'/'];
    }

    let mut result = Vec::new();
    for component in components {
        result.push(b'/');
        result.extend_from_slice(component);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_absolute_path_unchanged() {
        let resolved = resolve_path(b"/home/user/file.txt", b"/working/dir");
        assert_eq!(resolved, b"/home/user/file.txt");
    }

    #[test]
    fn test_relative_path_prepends_cwd() {
        let resolved = resolve_path(b"file.txt", b"/working/dir");
        assert_eq!(resolved, b"/working/dir/file.txt");
    }

    #[test]
    fn test_relative_path_with_cwd_root() {
        let resolved = resolve_path(b"file.txt", b"/");
        assert_eq!(resolved, b"/file.txt");
    }

    #[test]
    fn test_dot_relative_path() {
        let resolved = resolve_path(b"./file.txt", b"/working/dir");
        assert_eq!(resolved, b"/working/dir/file.txt");
    }

    #[test]
    fn test_empty_path() {
        let resolved = resolve_path(b"", b"/working/dir");
        assert_eq!(resolved, b"");
    }

    #[test]
    fn test_dot_resolves_to_cwd() {
        let resolved = resolve_path(b".", b"/dev");
        assert_eq!(resolved, b"/dev");
    }

    #[test]
    fn test_dotdot_relative_path() {
        let resolved = resolve_path(b"../file.txt", b"/working/dir");
        assert_eq!(resolved, b"/working/dir/../file.txt");
    }

    #[test]
    fn test_absolute_path_normalized() {
        let resolved = resolve_path(b"/dev/./pts/../null", b"/working/dir");
        assert_eq!(resolved, b"/dev/pts/../null");
    }

    #[test]
    fn test_clean_absolute() {
        assert_eq!(clean_path(b"/a/b/c"), b"/a/b/c");
    }

    #[test]
    fn test_clean_dot() {
        assert_eq!(clean_path(b"/a/./b/./c"), b"/a/b/c");
    }

    #[test]
    fn test_clean_preserves_dotdot() {
        assert_eq!(clean_path(b"/a/b/../c"), b"/a/b/../c");
    }

    #[test]
    fn test_clean_preserves_dotdot_past_root() {
        assert_eq!(clean_path(b"/a/../../b"), b"/a/../../b");
    }

    #[test]
    fn test_clean_root() {
        assert_eq!(clean_path(b"/"), b"/");
    }

    #[test]
    fn test_clean_trailing_slash() {
        assert_eq!(clean_path(b"/a/b/"), b"/a/b/");
    }

    #[test]
    fn test_clean_double_slash() {
        assert_eq!(clean_path(b"/a//b///c"), b"/a/b/c");
    }

    #[test]
    fn test_clean_only_dotdot() {
        assert_eq!(clean_path(b"/.."), b"/..");
    }

    #[test]
    fn test_clean_preserves_trailing_slash_after_dot() {
        assert_eq!(clean_path(b"/a/./"), b"/a/");
    }

    #[test]
    fn test_canonicalize_existing_path_collapses_dotdot() {
        assert_eq!(
            canonicalize_existing_path(b"/a/b/../c/./"),
            b"/a/c",
        );
        assert_eq!(canonicalize_existing_path(b"/.."), b"/");
    }
}
