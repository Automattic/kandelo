//! Resource limits shared by package-archive consumers.

/// Maximum decompressed tar stream accepted from a Kandelo binary package.
///
/// Package resolution has enforced this 1 GiB ceiling since remote package
/// archives were introduced. Keeping the value in one module prevents a
/// targeted archive reader from silently accepting bytes that the normal
/// package resolver would reject.
pub(crate) const MAX_PACKAGE_ARCHIVE_DECOMPRESSED_BYTES: u64 = 1024 * 1024 * 1024;

/// A member cannot be larger than the package stream that contains it.
pub(crate) const MAX_PACKAGE_ARCHIVE_MEMBER_BYTES: u64 = MAX_PACKAGE_ARCHIVE_DECOMPRESSED_BYTES;
