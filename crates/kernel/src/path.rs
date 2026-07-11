extern crate alloc;
use alloc::vec::Vec;

/// Make a pathname absolute without interpreting any of its components.
///
/// Pathname resolution is stateful: `missing/..` must look up `missing`, and
/// a `..` after a symlink applies to the symlink target rather than to the
/// spelling of the input. Callers that need POSIX resolution must therefore
/// preserve `.`, `..`, repeated separators, and a final slash until the
/// namespace walker has examined them.
pub fn make_absolute(path: &[u8], cwd: &[u8]) -> Vec<u8> {
    if path.is_empty() {
        return Vec::new();
    }
    if path[0] == b'/' {
        return path.to_vec();
    }

    let mut absolute = cwd.to_vec();
    if absolute.last() != Some(&b'/') {
        absolute.push(b'/');
    }
    absolute.extend_from_slice(path);
    absolute
}

/// Resolve a path against a working directory.
/// If path is absolute (starts with '/'), normalize and return it.
/// If path is relative, prepend cwd + '/' and normalize.
pub fn resolve_path(path: &[u8], cwd: &[u8]) -> Vec<u8> {
    if path.first() == Some(&b'/') {
        return normalize_path(path);
    }
    let mut resolved = cwd.to_vec();
    if resolved.last() != Some(&b'/') {
        resolved.push(b'/');
    }
    resolved.extend_from_slice(path);
    normalize_path(&resolved)
}

/// Normalize an absolute path by resolving `.` and `..` components.
/// Removes trailing slashes and redundant separators.
/// The input path must be absolute (start with '/').
pub fn normalize_path(path: &[u8]) -> Vec<u8> {
    let mut components: Vec<&[u8]> = Vec::new();

    for component in path.split(|&b| b == b'/') {
        match component {
            b"" | b"." => continue,
            b".." => {
                components.pop();
            }
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
    fn test_make_absolute_preserves_resolution_components() {
        assert_eq!(
            make_absolute(b"missing/../file/.", b"/working/dir"),
            b"/working/dir/missing/../file/."
        );
        assert_eq!(make_absolute(b"/a//b/../", b"/ignored"), b"/a//b/../");
        assert!(make_absolute(b"", b"/working/dir").is_empty());
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
        assert_eq!(resolved, b"/working/dir");
    }

    #[test]
    fn test_dot_resolves_to_cwd() {
        let resolved = resolve_path(b".", b"/dev");
        assert_eq!(resolved, b"/dev");
    }

    #[test]
    fn test_dotdot_relative_path() {
        let resolved = resolve_path(b"../file.txt", b"/working/dir");
        assert_eq!(resolved, b"/working/file.txt");
    }

    #[test]
    fn test_absolute_path_normalized() {
        let resolved = resolve_path(b"/dev/./pts/../null", b"/working/dir");
        assert_eq!(resolved, b"/dev/null");
    }

    #[test]
    fn test_normalize_absolute() {
        assert_eq!(normalize_path(b"/a/b/c"), b"/a/b/c");
    }

    #[test]
    fn test_normalize_dot() {
        assert_eq!(normalize_path(b"/a/./b/./c"), b"/a/b/c");
    }

    #[test]
    fn test_normalize_dotdot() {
        assert_eq!(normalize_path(b"/a/b/../c"), b"/a/c");
    }

    #[test]
    fn test_normalize_dotdot_past_root() {
        assert_eq!(normalize_path(b"/a/../../b"), b"/b");
    }

    #[test]
    fn test_normalize_root() {
        assert_eq!(normalize_path(b"/"), b"/");
    }

    #[test]
    fn test_normalize_trailing_slash() {
        assert_eq!(normalize_path(b"/a/b/"), b"/a/b");
    }

    #[test]
    fn test_normalize_double_slash() {
        assert_eq!(normalize_path(b"/a//b///c"), b"/a/b/c");
    }

    #[test]
    fn test_normalize_only_dotdot() {
        assert_eq!(normalize_path(b"/.."), b"/");
    }
}
