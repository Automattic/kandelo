#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
mod wasm {
    extern crate alloc;

    use alloc::vec::Vec;
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::UnsafeCell;
    use core::sync::atomic::{AtomicBool, Ordering};
    use dlmalloc::Dlmalloc;
    use runtime_core::persistent_overlay::{Mutation, OverlayJournal, OverlayKey, OverlayStorage};
    use spin::Mutex;
    use wasm_posix_shared::Errno;

    struct PrototypeAllocator {
        locked: AtomicBool,
        allocator: UnsafeCell<Dlmalloc>,
    }

    unsafe impl Sync for PrototypeAllocator {}

    struct AllocatorGuard<'a>(&'a PrototypeAllocator);

    impl Drop for AllocatorGuard<'_> {
        fn drop(&mut self) {
            self.0.locked.store(false, Ordering::Release);
        }
    }

    impl PrototypeAllocator {
        const fn new() -> Self {
            Self {
                locked: AtomicBool::new(false),
                allocator: UnsafeCell::new(Dlmalloc::new()),
            }
        }

        fn lock(&self) -> AllocatorGuard<'_> {
            while self
                .locked
                .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
                .is_err()
            {
                core::hint::spin_loop();
            }
            AllocatorGuard(self)
        }
    }

    unsafe impl GlobalAlloc for PrototypeAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let _guard = self.lock();
            unsafe { (&mut *self.allocator.get()).malloc(layout.size(), layout.align()) }
        }

        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            let _guard = self.lock();
            unsafe { (&mut *self.allocator.get()).free(ptr, layout.size(), layout.align()) }
        }

        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            let _guard = self.lock();
            unsafe { (&mut *self.allocator.get()).calloc(layout.size(), layout.align()) }
        }

        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            let _guard = self.lock();
            unsafe {
                (&mut *self.allocator.get()).realloc(ptr, layout.size(), layout.align(), new_size)
            }
        }
    }

    #[global_allocator]
    static ALLOC: PrototypeAllocator = PrototypeAllocator::new();

    #[panic_handler]
    fn panic(_info: &core::panic::PanicInfo) -> ! {
        core::arch::wasm32::unreachable()
    }

    #[link(wasm_import_module = "env")]
    unsafe extern "C" {
        fn overlay_len() -> i64;
        fn overlay_read(offset: i64, ptr: *mut u8, len: u32) -> i32;
        fn overlay_write(offset: i64, ptr: *const u8, len: u32) -> i32;
        fn overlay_flush() -> i32;
        fn overlay_truncate(len: i64) -> i32;
        fn base_read(offset: i64, ptr: *mut u8, len: u32) -> i32;
    }

    static SCRATCH: Mutex<Vec<u8>> = Mutex::new(Vec::new());
    static JOURNAL: Mutex<Option<OverlayJournal<HostStorage>>> = Mutex::new(None);

    struct HostStorage;

    fn offset_i64(value: u64) -> Result<i64, Errno> {
        i64::try_from(value).map_err(|_| Errno::EOVERFLOW)
    }

    fn status(result: i32) -> Result<(), Errno> {
        if result == 0 { Ok(()) } else { Err(Errno::EIO) }
    }

    impl OverlayStorage for HostStorage {
        fn len(&mut self) -> Result<u64, Errno> {
            let result = unsafe { overlay_len() };
            u64::try_from(result).map_err(|_| Errno::EIO)
        }

        fn read_exact_at(&mut self, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
            let offset = offset_i64(offset)?;
            let length = u32::try_from(dst.len()).map_err(|_| Errno::EOVERFLOW)?;
            status(unsafe { overlay_read(offset, dst.as_mut_ptr(), length) })
        }

        fn write_all_at(&mut self, offset: u64, src: &[u8]) -> Result<(), Errno> {
            let offset = offset_i64(offset)?;
            let length = u32::try_from(src.len()).map_err(|_| Errno::EOVERFLOW)?;
            status(unsafe { overlay_write(offset, src.as_ptr(), length) })
        }

        fn flush(&mut self) -> Result<(), Errno> {
            status(unsafe { overlay_flush() })
        }

        fn truncate(&mut self, len: u64) -> Result<(), Errno> {
            status(unsafe { overlay_truncate(offset_i64(len)?) })
        }
    }

    fn read_base(offset: u64, dst: &mut [u8]) -> Result<usize, Errno> {
        let offset = offset_i64(offset)?;
        let length = u32::try_from(dst.len()).map_err(|_| Errno::EOVERFLOW)?;
        let result = unsafe { base_read(offset, dst.as_mut_ptr(), length) };
        usize::try_from(result).map_err(|_| Errno::EIO)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn prototype_scratch(length: u32) -> u32 {
        if length > 1024 * 1024 {
            return 0;
        }
        let mut scratch = SCRATCH.lock();
        scratch.resize(length as usize, 0);
        scratch.as_mut_ptr() as u32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn prototype_open() -> i32 {
        let scratch = SCRATCH.lock();
        let digest: [u8; 32] = match scratch.get(..32).and_then(|bytes| bytes.try_into().ok()) {
            Some(value) => value,
            None => return -(Errno::EINVAL as i32),
        };
        let mut journal = JOURNAL.lock();
        if journal.is_some() {
            return -(Errno::EBUSY as i32);
        }
        match OverlayJournal::open(HostStorage, digest) {
            Ok(opened) => {
                *journal = Some(opened);
                0
            }
            Err(error) => -(error as i32),
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn prototype_size(inode: u64, base_size: u64) -> i64 {
        let journal = JOURNAL.lock();
        let Some(journal) = journal.as_ref() else {
            return -(Errno::EBADF as i64);
        };
        match journal.state().file_size(inode, base_size) {
            Ok(size) => i64::try_from(size).unwrap_or(-(Errno::EOVERFLOW as i64)),
            Err(error) => -(error as i64),
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn prototype_lookup(parent: u64, name_length: u32) -> i64 {
        let scratch = SCRATCH.lock();
        let Some(name) = scratch.get(..name_length as usize) else {
            return -(Errno::EINVAL as i64);
        };
        let journal = JOURNAL.lock();
        let Some(journal) = journal.as_ref() else {
            return -(Errno::EBADF as i64);
        };
        let key = OverlayKey::Dirent {
            parent,
            name: name.to_vec(),
        };
        match journal.state().lookup(&key) {
            Some(Some(bytes)) if bytes.len() == 8 => match bytes.try_into() {
                Ok(encoded) => {
                    i64::try_from(u64::from_le_bytes(encoded)).unwrap_or(-(Errno::EOVERFLOW as i64))
                }
                Err(_) => -(Errno::EIO as i64),
            },
            Some(Some(_)) => -(Errno::EIO as i64),
            _ => -(Errno::ENOENT as i64),
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn prototype_create(parent: u64, inode: u64, name_length: u32) -> i32 {
        let scratch = SCRATCH.lock();
        let Some(name) = scratch.get(..name_length as usize) else {
            return -(Errno::EINVAL as i32);
        };
        let mut journal = JOURNAL.lock();
        let Some(journal) = journal.as_mut() else {
            return -(Errno::EBADF as i32);
        };
        let dirent = OverlayKey::Dirent {
            parent,
            name: name.to_vec(),
        };
        if journal.state().lookup(&dirent).is_some()
            || journal.state().lookup(&OverlayKey::Inode(inode)).is_some()
        {
            return -(Errno::EEXIST as i32);
        }
        let mutations = [
            Mutation::Put {
                key: OverlayKey::Inode(inode),
                value: 0o100600u32.to_le_bytes().to_vec(),
            },
            Mutation::Put {
                key: OverlayKey::FileSize(inode),
                value: 0u64.to_le_bytes().to_vec(),
            },
            Mutation::Put {
                key: dirent,
                value: inode.to_le_bytes().to_vec(),
            },
        ];
        match journal.commit(&mutations) {
            Ok(()) => 0,
            Err(error) => -(error as i32),
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn prototype_read(inode: u64, base_size: u64, offset: u64, length: u32) -> i32 {
        let mut scratch = SCRATCH.lock();
        let Some(dst) = scratch.get_mut(..length as usize) else {
            return -(Errno::EINVAL as i32);
        };
        let mut journal = JOURNAL.lock();
        let Some(journal) = journal.as_mut() else {
            return -(Errno::EBADF as i32);
        };
        match journal.read_file_at(inode, base_size, offset, dst, read_base) {
            Ok(read) => read as i32,
            Err(error) => -(error as i32),
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn prototype_write(inode: u64, base_size: u64, offset: u64, length: u32) -> i32 {
        let scratch = SCRATCH.lock();
        let Some(src) = scratch.get(..length as usize) else {
            return -(Errno::EINVAL as i32);
        };
        let mut journal = JOURNAL.lock();
        let Some(journal) = journal.as_mut() else {
            return -(Errno::EBADF as i32);
        };
        match journal.write_file_at(inode, base_size, offset, src, read_base) {
            Ok(written) => written as i32,
            Err(error) => -(error as i32),
        }
    }
}
