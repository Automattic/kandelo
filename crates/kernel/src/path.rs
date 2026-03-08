extern crate alloc;
use alloc::vec::Vec;

/// Resolve a path against a working directory.
/// If path is absolute (starts with '/'), return it as-is.
/// If path is relative, prepend cwd + '/'.
pub fn resolve_path(path: &[u8], cwd: &[u8]) -> Vec<u8> {
    if path.first() == Some(&b'/') {
        return path.to_vec();
    }
    let mut resolved = cwd.to_vec();
    if resolved.last() != Some(&b'/') {
        resolved.push(b'/');
    }
    resolved.extend_from_slice(path);
    resolved
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
        assert_eq!(resolved, b"/working/dir/./file.txt");
    }

    #[test]
    fn test_empty_path() {
        let resolved = resolve_path(b"", b"/working/dir");
        assert_eq!(resolved, b"/working/dir/");
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
