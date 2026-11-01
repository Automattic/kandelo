use super::*;
use core::cell::UnsafeCell;
use runtime_core::IoBuffer;
use runtime_core::rootfs::package_producer::Builder;

enum State {
    Building(Builder),
    Ready(IoBuffer<u8>),
}

struct StateCell(UnsafeCell<Option<State>>);
unsafe impl Sync for StateCell {}
static STATE: StateCell = StateCell(UnsafeCell::new(None));

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_package_inventory_begin(
    program_abi: u32, digest: usize, name: usize, name_length: usize,
    version: usize, version_length: usize,
) -> i32 {
    if digest == 0 || name == 0 || version == 0 || name_length > 128 || version_length > 128 { return err(Errno::EINVAL); }
    let slot = unsafe { &mut *STATE.0.get() };
    if slot.is_some() { return err(Errno::EBUSY); }
    let digest = unsafe { *(digest as *const [u8; 32]) };
    let builder = Builder::new(program_abi, digest,
        unsafe { slice(name, name_length) }, unsafe { slice(version, version_length) });
    match builder {
        Ok(builder) => { *slot = Some(State::Building(builder)); 0 }
        Err(error) => err(error),
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_package_inventory_inherit(pointer: usize, length: usize) -> i32 {
    if pointer == 0 { return err(Errno::EINVAL); }
    if length > runtime_core::package_inventory::MAX_BYTES { return err(Errno::E2BIG); }
    let Some(State::Building(builder)) = (unsafe { &mut *STATE.0.get() }) else { return err(Errno::EINVAL); };
    match builder.inherit(unsafe { slice(pointer, length) }) {
        Ok(count) => count as i32,
        Err(error) => err(error),
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_package_inventory_add(path: usize, length: usize, declared_digest: usize) -> i32 {
    if path == 0 || length > 4096 { return err(Errno::EINVAL); }
    let Some(State::Building(builder)) = (unsafe { &mut *STATE.0.get() }) else { return err(Errno::EINVAL); };
    let digest = if declared_digest == 0 { None } else { Some(unsafe { *(declared_digest as *const [u8; 32]) }) };
    ok_or_errno(builder.add(unsafe { slice(path, length) }, digest, &mut image_source))
}

#[unsafe(no_mangle)]
pub extern "C" fn sm_package_inventory_finish() -> i32 {
    let slot = unsafe { &mut *STATE.0.get() };
    let Some(State::Building(builder)) = slot.take() else { return err(Errno::EINVAL); };
    match builder.finish() {
        Ok(bytes) => { let length = bytes.len() as i32; *slot = Some(State::Ready(bytes)); length }
        Err(error) => err(error),
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_package_inventory_read(offset: usize, output: usize, length: usize) -> i32 {
    if output == 0 || length > 64 * 1024 { return err(Errno::EINVAL); }
    let Some(State::Ready(bytes)) = (unsafe { &*STATE.0.get() }) else { return err(Errno::EINVAL); };
    if offset > bytes.len() { return err(Errno::EINVAL); }
    let count = length.min(bytes.len() - offset);
    unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr().add(offset), output as *mut u8, count) };
    count as i32
}

#[unsafe(no_mangle)]
pub extern "C" fn sm_package_inventory_cancel() {
    unsafe { *STATE.0.get() = None };
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_package_inventory_pin_sources(
    pointer: usize, length: usize, directory: usize, directory_length: usize,
) -> i32 {
    if pointer == 0 || directory == 0 { return err(Errno::EINVAL); }
    if length > runtime_core::package_inventory::MAX_BYTES || directory_length > 4096 { return err(Errno::E2BIG); }
    let slot = unsafe { &mut *STATE.0.get() };
    if slot.is_some() { return err(Errno::EBUSY); }
    match runtime_core::rootfs::package_sources::pin_inventory(
        unsafe { slice(pointer, length) }, unsafe { slice(directory, directory_length) },
    ) {
        Ok(bytes) => { let length = bytes.len() as i32; *slot = Some(State::Ready(bytes)); length }
        Err(error) => err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn producer_exports_build_read_cancel_and_reset_native_inventory() {
        sm_reset(0o755, 0, 0);
        let digest = [7u8; 32];
        let name = b"base";
        let version = b"1";
        let begin = || unsafe { sm_package_inventory_begin(55, digest.as_ptr() as usize,
            name.as_ptr() as usize, name.len(), version.as_ptr() as usize, version.len()) };
        assert_eq!(begin(), 0);
        assert_eq!(begin(), err(Errno::EBUSY));
        let parent = runtime_core::package_inventory::encode(55, digest,
            &[runtime_core::package_inventory::PackageSpec { name: b"parent", version: b"1", content_digest: None, dependencies: &[] }], &[]).unwrap();
        assert_eq!(unsafe { sm_package_inventory_inherit(0, parent.len()) }, err(Errno::EINVAL));
        assert_eq!(unsafe { sm_package_inventory_inherit(parent.as_ptr() as usize, parent.len()) }, 0);
        assert_eq!(unsafe { sm_package_inventory_inherit(parent.as_ptr() as usize, parent.len()) }, err(Errno::EBUSY));
        let path = b"/";
        assert_eq!(unsafe { sm_package_inventory_add(path.as_ptr() as usize, path.len(), 0) }, 0);
        let length = sm_package_inventory_finish();
        assert!(length > 0);
        let mut bytes = alloc::vec![0; length as usize];
        assert_eq!(unsafe { sm_package_inventory_read(0, bytes.as_mut_ptr() as usize, bytes.len()) }, length);
        let inventory = runtime_core::package_inventory::Inventory::decode(&bytes).unwrap();
        assert_eq!(inventory.files().len(), 1);
        assert_eq!(inventory.files()[0].path, b"/");
        assert_eq!(unsafe { sm_package_inventory_read(bytes.len() + 1, bytes.as_mut_ptr() as usize, 1) }, err(Errno::EINVAL));
        sm_package_inventory_cancel();
        assert_eq!(unsafe { sm_package_inventory_inherit(parent.as_ptr() as usize, parent.len()) }, err(Errno::EINVAL));
        assert_eq!(unsafe { sm_package_inventory_read(0, bytes.as_mut_ptr() as usize, 1) }, err(Errno::EINVAL));
        assert_eq!(begin(), 0);
        sm_reset(0o755, 0, 0);
        assert_eq!(sm_package_inventory_finish(), err(Errno::EINVAL));
        assert_eq!(begin(), 0);
        sm_package_inventory_cancel();
    }

    #[test]
    fn source_binding_exports_preserve_existing_sessions_and_stream_independent_results() {
        sm_reset(0o755, 0, 0);
        let bytes = runtime_core::package_inventory::encode(55, [7; 32], &[], &[]).unwrap();
        let directory = alloc::format!("https://example.test/{}/", "a".repeat(64));
        let pin = || unsafe { sm_package_inventory_pin_sources(bytes.as_ptr() as usize, bytes.len(), directory.as_ptr() as usize, directory.len()) };
        assert_eq!(unsafe { sm_package_inventory_pin_sources(0, bytes.len(), directory.as_ptr() as usize, directory.len()) }, err(Errno::EINVAL));
        assert_eq!(pin(), bytes.len() as i32);
        assert_eq!(pin(), err(Errno::EBUSY));
        let mut output = [0; 256];
        let count = unsafe { sm_package_inventory_read(0, output.as_mut_ptr() as usize, output.len()) };
        assert_eq!(&output[..count as usize], bytes.as_slice());
        sm_package_inventory_cancel();
        assert_eq!(pin(), bytes.len() as i32);
        sm_reset(0o755, 0, 0);
        assert_eq!(pin(), bytes.len() as i32);
        sm_package_inventory_cancel();
    }
}
