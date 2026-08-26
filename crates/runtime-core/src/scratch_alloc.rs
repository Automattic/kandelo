//! Kernel-owned host scratch allocation constraints.

use alloc::alloc::Layout;

const SCRATCH_ALIGNMENT: usize = 16;

pub fn layout(size: usize) -> Option<Layout> {
    // WHY: `Layout` requires the allocation, including alignment padding, to
    // fit in `isize::MAX`. Large u32 requests are therefore outside the
    // allocator domain on wasm32. A host-facing allocation request must report
    // that as failure instead of trapping while it constructs the layout.
    if size == 0 {
        return None;
    }
    Layout::from_size_align(size, SCRATCH_ALIGNMENT).ok()
}

#[cfg(test)]
mod tests {
    use super::{SCRATCH_ALIGNMENT, layout};

    #[test]
    fn rejects_zero_and_sizes_outside_the_allocator_domain() {
        assert!(layout(0).is_none());
        assert!(layout(usize::MAX).is_none());
    }

    #[test]
    fn accepts_the_exact_aligned_allocator_boundary() {
        let maximum = (isize::MAX as usize) & !(SCRATCH_ALIGNMENT - 1);
        assert_eq!(layout(maximum).expect("maximum layout").size(), maximum);
        assert!(layout(maximum + 1).is_none());
    }

    #[test]
    fn accepts_aligned_and_unaligned_ordinary_sizes() {
        let aligned = layout(64 * 1024).expect("ordinary channel scratch");
        assert_eq!(aligned.size(), 64 * 1024);
        assert_eq!(aligned.align(), SCRATCH_ALIGNMENT);

        let unaligned = layout(65_609).expect("unaligned scratch");
        assert_eq!(unaligned.size(), 65_609);
        assert_eq!(unaligned.align(), SCRATCH_ALIGNMENT);
    }
}
