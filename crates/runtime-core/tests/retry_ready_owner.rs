#![cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
// Standalone native control links the exact production helper module. It does
// not compile or validate Parks, descriptor, kernel or host integration.
#[path = "../src/retry_ready.rs"]
mod actual;
    use actual::ReadySources;
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    struct Counted;
    static MEASURE: AtomicBool = AtomicBool::new(false);
    static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
    unsafe impl GlobalAlloc for Counted {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            if MEASURE.load(Ordering::Relaxed) { ALLOCATIONS.fetch_add(1, Ordering::Relaxed); }
            unsafe { System.alloc(layout) }
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) { unsafe { System.dealloc(ptr, layout) } }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, length: usize) -> *mut u8 {
            if MEASURE.load(Ordering::Relaxed) { ALLOCATIONS.fetch_add(1, Ordering::Relaxed); }
            unsafe { System.realloc(ptr, layout, length) }
        }
    }
    #[global_allocator] static ALLOCATOR: Counted = Counted;
    #[test]
    fn actual_publication_duplicate_and_reuse_allocate_nothing() {
        let mut sources = ReadySources::new();sources.prepare(2).unwrap();
        ALLOCATIONS.store(0, Ordering::Relaxed);MEASURE.store(true, Ordering::Relaxed);
        sources.record(1);sources.record(1);sources.record(2);
        assert!(sources.contains(&1) && sources.contains(&2));sources.clear();
        sources.record(3);sources.record(4);MEASURE.store(false, Ordering::Relaxed);
        assert_eq!(ALLOCATIONS.load(Ordering::Relaxed), 0);
    }
    #[test]
    fn failed_admission_keeps_already_committed_dirty_sources() {
        let mut sources = ReadySources::new();sources.prepare(1).unwrap();sources.record(7);
        assert!(sources.prepare(usize::MAX).is_err());assert!(sources.contains(&7));
        sources.clear();sources.record(8);assert!(sources.contains(&8));
    }
    #[test]
    fn stale_sources_and_new_retry_capacity_coexist_until_settle() {
        let mut sources = ReadySources::new();sources.prepare(2).unwrap();sources.record(1);sources.record(2);
        sources.prepare(2).unwrap();sources.record(3);sources.record(4);
        for value in 1..=4 { assert!(sources.contains(&value)); }
        sources.clear();assert!(sources.is_empty());
    }
    #[test]
    #[should_panic(expected = "pre-admitted capacity")]
    fn an_unadmitted_publisher_cannot_silently_allocate_or_drop() {
        let mut sources = ReadySources::new();sources.record(1);
    }
