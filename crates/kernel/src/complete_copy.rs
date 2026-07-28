//! Complete, capacity-aware copies for kernel-owned byte state.
//!
//! Canonical paths can legitimately exceed `PATH_MAX`: that limit bounds one
//! caller-supplied pathname, not the canonical path formed from an already
//! deep current working directory. A short destination must therefore remain
//! untouched and report `ERANGE`; silently publishing a prefix can name a
//! different executable or shared-mapping backing. The same primitive keeps
//! future variable byte exports from silently reviving prefix semantics.
//!
//! This module proves only complete-or-error byte-count behavior. The host
//! scratch lease must independently prove allocator ownership, capacity,
//! current-memory bounds, pointer width, lifetime, and reentrancy.

use wasm_posix_shared::Errno;

fn checked_complete_copy_length(
    source_length: usize,
    capacity: u32,
) -> Result<usize, Errno> {
    i32::try_from(source_length).map_err(|_| Errno::EOVERFLOW)?;
    if capacity > 0 && source_length > capacity as usize {
        return Err(Errno::ERANGE);
    }
    Ok(source_length)
}

/// Copy all bytes, query the required length, or fail without a partial copy.
///
/// # Safety
///
/// When `capacity` is positive and at least `source.len()`, `destination`
/// must name a writable allocation of at least `source.len()` bytes that does
/// not overlap `source`. Query and short-capacity calls do not dereference it.
pub(crate) unsafe fn copy_complete_bytes(
    source: &[u8],
    destination: *mut u8,
    capacity: u32,
) -> i32 {
    let required = match checked_complete_copy_length(source.len(), capacity) {
        Ok(length) => length,
        Err(error) => return -(error as i32),
    };
    if capacity == 0 {
        // A zero-capacity call is the required-length query. Its pointer is
        // deliberately ignored so wasm32 and wasm64 hosts need no sentinel
        // address outside an allocator-owned lease.
        return required as i32;
    }
    if destination.is_null() {
        return -(Errno::EFAULT as i32);
    }
    let output = unsafe { core::slice::from_raw_parts_mut(destination, source.len()) };
    output.copy_from_slice(source);
    required as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_destination_is_atomic_and_exact_capacity_retries() {
        let source = b"/deep/canonical/path";
        let mut guarded = [0xa5; 24];

        assert_eq!(
            unsafe {
                copy_complete_bytes(source, guarded.as_mut_ptr(), source.len() as u32 - 1)
            },
            -(Errno::ERANGE as i32),
        );
        assert!(guarded.iter().all(|byte| *byte == 0xa5));

        assert_eq!(
            unsafe {
                copy_complete_bytes(source, guarded.as_mut_ptr(), source.len() as u32)
            },
            source.len() as i32,
        );
        assert_eq!(&guarded[..source.len()], source);
        assert!(guarded[source.len()..].iter().all(|byte| *byte == 0xa5));

        guarded.fill(0xa5);
        assert_eq!(
            unsafe {
                copy_complete_bytes(
                    source,
                    guarded.as_mut_ptr(),
                    source.len() as u32 + 1,
                )
            },
            source.len() as i32,
        );
        assert_eq!(&guarded[..source.len()], source);
        assert_eq!(guarded[source.len()], 0xa5);
    }

    #[test]
    fn zero_capacity_queries_without_dereferencing_and_positive_capacity_needs_pointer() {
        let source = b"/query";
        assert_eq!(
            unsafe { copy_complete_bytes(source, core::ptr::null_mut(), 0) },
            source.len() as i32,
        );
        assert_eq!(
            unsafe {
                copy_complete_bytes(source, core::ptr::null_mut(), source.len() as u32)
            },
            -(Errno::EFAULT as i32),
        );
    }

    #[test]
    fn unreportable_length_fails_without_allocating_the_source() {
        let oversized = (i32::MAX as usize).checked_add(1).unwrap();
        assert_eq!(
            checked_complete_copy_length(oversized, 0),
            Err(Errno::EOVERFLOW),
        );
    }
}
