use runtime_core::IoBuffer;
use runtime_core::kandelo_image_fs::BlockSource;
use runtime_core::persistent_image::{
    CacheConfig, DATA_BYTES, ImageBuilder, ImageIdentity, IntegrityPolicy, PositionedImageWriter,
    VerifiedImage,
};
use spin::Mutex;
use wasm_posix_shared::Errno;

unsafe extern "C" {
    fn host_image_target_size(target: u32) -> i64;
    fn host_image_target_write(target: u32, offset: i64, pointer: *const u8, length: u32) -> i32;
    fn host_image_target_read(target: u32, offset: i64, pointer: *mut u8, length: u32) -> i32;
    fn host_image_target_truncate(target: u32, length: i64) -> i32;
    fn host_image_target_flush(target: u32) -> i32;
}

#[derive(Clone, Copy)]
struct HostTarget(u32, u64);

struct InputImage(u64);

impl BlockSource for InputImage {
    fn len(&self) -> u64 {
        self.0
    }

    fn read_exact_at(&self, offset: u64, destination: &mut [u8]) -> Result<(), Errno> {
        if offset
            .checked_add(destination.len() as u64)
            .filter(|end| *end <= self.0)
            .is_none()
        {
            return Err(Errno::EIO);
        }
        let mut consumed = 0;
        while consumed < destination.len() {
            let count = super::persistent_physical_read(
                offset + consumed as u64,
                &mut destination[consumed..],
            )?;
            if count == 0 || count > destination.len() - consumed {
                return Err(Errno::EIO);
            }
            consumed += count;
        }
        Ok(())
    }
}

fn checked_result(result: i64) -> Result<u64, Errno> {
    if result < 0 {
        let error = u32::try_from(result.unsigned_abs())
            .ok()
            .and_then(Errno::from_u32)
            .unwrap_or(Errno::EIO);
        Err(error)
    } else {
        Ok(result as u64)
    }
}

fn checked_status(result: i32) -> Result<(), Errno> {
    match checked_result(i64::from(result))? {
        0 => Ok(()),
        _ => Err(Errno::EIO),
    }
}

impl PositionedImageWriter for HostTarget {
    fn get_size(&self) -> Result<u64, Errno> {
        checked_result(unsafe { host_image_target_size(self.0) })
    }

    fn write_all_at(&mut self, offset: u64, bytes: &[u8]) -> Result<(), Errno> {
        let mut consumed = 0;
        while consumed < bytes.len() {
            let position = offset
                .checked_add(consumed as u64)
                .ok_or(Errno::EOVERFLOW)?;
            let position = i64::try_from(position).map_err(|_| Errno::EOVERFLOW)?;
            let count = (bytes.len() - consumed).min(DATA_BYTES);
            let result = unsafe {
                host_image_target_write(self.0, position, bytes[consumed..].as_ptr(), count as u32)
            };
            let written = checked_result(i64::from(result))? as usize;
            if written == 0 || written > count {
                return Err(Errno::EIO);
            }
            consumed += written;
        }
        Ok(())
    }

    fn set_size(&mut self, length: u64) -> Result<(), Errno> {
        let length = i64::try_from(length).map_err(|_| Errno::EOVERFLOW)?;
        checked_status(unsafe { host_image_target_truncate(self.0, length) })
    }

    fn flush(&mut self) -> Result<(), Errno> {
        checked_status(unsafe { host_image_target_flush(self.0) })
    }
}

impl BlockSource for HostTarget {
    fn len(&self) -> u64 {
        self.1
    }

    fn read_exact_at(&self, offset: u64, destination: &mut [u8]) -> Result<(), Errno> {
        if self.get_size()? != self.1
            || offset
                .checked_add(destination.len() as u64)
                .filter(|end| *end <= self.1)
                .is_none()
        {
            return Err(Errno::EIO);
        }
        let mut consumed = 0;
        while consumed < destination.len() {
            let position = i64::try_from(offset + consumed as u64).map_err(|_| Errno::EOVERFLOW)?;
            let count = (destination.len() - consumed).min(DATA_BYTES);
            let result = unsafe {
                host_image_target_read(
                    self.0,
                    position,
                    destination[consumed..].as_mut_ptr(),
                    count as u32,
                )
            };
            let read = checked_result(i64::from(result))? as usize;
            if read == 0 || read > count {
                return Err(Errno::EIO);
            }
            consumed += read;
        }
        Ok(())
    }
}

enum State {
    Idle,
    Building {
        target: HostTarget,
        builder: ImageBuilder<HostTarget>,
    },
    Checking {
        image: VerifiedImage<HostTarget>,
        identity: ImageIdentity,
        position: u64,
        scratch: IoBuffer<u8>,
    },
    Complete(ImageIdentity),
    Failed,
}

static WRITER: Mutex<State> = Mutex::new(State::Idle);

#[unsafe(no_mangle)]
pub extern "C" fn sm_persistent_image_inspect(
    length_lo: u32,
    length_hi: u32,
    digest0: u32,
    digest1: u32,
    digest2: u32,
    digest3: u32,
    digest4: u32,
    digest5: u32,
    digest6: u32,
    digest7: u32,
    policy: u32,
) -> i64 {
    match enter(|state| {
        if !matches!(state, State::Idle) {
            return Err(Errno::EBUSY);
        }
        let policy = match policy {
            1 => IntegrityPolicy::Crc32c,
            2 => IntegrityPolicy::Sha256,
            _ => return Err(Errno::EINVAL),
        };
        let mut expected = [0u8; 32];
        for (index, word) in [
            digest0, digest1, digest2, digest3, digest4, digest5, digest6, digest7,
        ]
        .into_iter()
        .enumerate()
        {
            expected[index * 4..index * 4 + 4].copy_from_slice(&word.to_le_bytes());
        }
        let length = (u64::from(length_hi) << 32) | u64::from(length_lo);
        let image = VerifiedImage::open(InputImage(length), expected, CacheConfig::new(1, 1)?)?;
        if image.policy() != policy {
            return Err(Errno::EINVAL);
        }
        i64::try_from(image.payload_length()).map_err(|_| Errno::EOVERFLOW)
    }) {
        Ok(length) => length,
        Err(error) => i64::from(super::err(error)),
    }
}

fn enter<ResultValue>(
    operation: impl FnOnce(&mut State) -> Result<ResultValue, Errno>,
) -> Result<ResultValue, Errno> {
    let mut state = WRITER.try_lock().ok_or(Errno::EBUSY)?;
    operation(&mut state)
}

fn status(result: Result<(), Errno>) -> i32 {
    result.map_or_else(super::err, |()| 0)
}

#[unsafe(no_mangle)]
pub extern "C" fn sm_persistent_image_begin(
    target: u32,
    length_lo: u32,
    length_hi: u32,
    policy: u32,
) -> i32 {
    status(enter(|state| {
        if !matches!(state, State::Idle) {
            return Err(Errno::EBUSY);
        }
        if target == 0 {
            return Err(Errno::EINVAL);
        }
        let policy = match policy {
            1 => IntegrityPolicy::Crc32c,
            2 => IntegrityPolicy::Sha256,
            _ => return Err(Errno::EINVAL),
        };
        let length = (u64::from(length_hi) << 32) | u64::from(length_lo);
        let target = HostTarget(target, 0);
        *state = State::Failed;
        let builder = ImageBuilder::begin(length, policy, target)?;
        *state = State::Building { target, builder };
        Ok(())
    }))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_persistent_image_push(pointer: usize, length: usize) -> i32 {
    if pointer == 0 || length == 0 || length > DATA_BYTES {
        return super::err(Errno::EINVAL);
    }
    status(enter(|state| {
        let State::Building { builder, .. } = state else {
            return Err(Errno::EINVAL);
        };
        let bytes = unsafe { core::slice::from_raw_parts(pointer as *const u8, length) };
        let result = if bytes.iter().all(|byte| *byte == 0) {
            builder.push_zeroes(length as u64)
        } else {
            builder.push(bytes)
        };
        if result.is_err() {
            *state = State::Failed;
        }
        result
    }))
}

#[unsafe(no_mangle)]
pub extern "C" fn sm_persistent_image_finish() -> i32 {
    status(enter(|state| {
        if !matches!(state, State::Building { .. }) {
            return Err(Errno::EINVAL);
        }
        let State::Building { target, builder } = core::mem::replace(state, State::Failed) else {
            return Err(Errno::EIO);
        };
        let identity = builder.finish()?;
        let image = VerifiedImage::open(
            HostTarget(target.0, identity.physical_length),
            identity.digest,
            CacheConfig::new(1, 1)?,
        )?;
        let scratch = IoBuffer::try_filled(DATA_BYTES, 0)?;
        *state = State::Checking {
            image,
            identity,
            position: 0,
            scratch,
        };
        Ok(())
    }))
}

#[unsafe(no_mangle)]
pub extern "C" fn sm_persistent_image_check_step() -> i32 {
    match enter(|state| {
        let mut complete = None;
        let result = match state {
            State::Checking {
                image,
                identity,
                position,
                scratch,
            } => {
                let count = (identity.payload_length - *position).min(DATA_BYTES as u64) as usize;
                image
                    .read_exact_at(*position, &mut scratch[..count])
                    .map(|()| {
                        *position += count as u64;
                        if *position == identity.payload_length {
                            complete = Some(*identity);
                        }
                        count as i32
                    })
            }
            State::Complete(_) => Ok(0),
            _ => return Err(Errno::EINVAL),
        };
        if let Some(identity) = complete {
            *state = State::Complete(identity);
        }
        if result.is_err() {
            *state = State::Failed;
        }
        result
    }) {
        Ok(count) => count,
        Err(error) => super::err(error),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn sm_persistent_image_identity_word(index: u32) -> i64 {
    match enter(|state| {
        let State::Complete(identity) = state else {
            return Err(Errno::EINVAL);
        };
        let value = match index {
            0..=7 => {
                let start = index as usize * 4;
                u32::from_le_bytes(
                    identity.digest[start..start + 4]
                        .try_into()
                        .map_err(|_| Errno::EIO)?,
                )
            }
            8 => identity.payload_length as u32,
            9 => (identity.payload_length >> 32) as u32,
            10 => identity.physical_length as u32,
            11 => (identity.physical_length >> 32) as u32,
            _ => return Err(Errno::EINVAL),
        };
        Ok(i64::from(value))
    }) {
        Ok(value) => value,
        Err(error) => i64::from(super::err(error)),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn sm_persistent_image_cancel() -> i32 {
    status(enter(|state| {
        *state = State::Idle;
        Ok(())
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;

    #[derive(Default)]
    struct Target {
        bytes: Vec<u8>,
        corrupt_flush: bool,
        fail_write: bool,
        fail_read: bool,
        reenter: bool,
        flushes: usize,
    }

    static TARGET: std::sync::Mutex<Target> = std::sync::Mutex::new(Target {
        bytes: Vec::new(),
        corrupt_flush: false,
        fail_write: false,
        fail_read: false,
        reenter: false,
        flushes: 0,
    });

    #[unsafe(no_mangle)]
    extern "C" fn host_image_target_size(token: u32) -> i64 {
        assert_eq!(token, 11);
        TARGET.lock().unwrap().bytes.len() as i64
    }

    #[unsafe(no_mangle)]
    unsafe extern "C" fn host_image_target_write(
        token: u32,
        offset: i64,
        pointer: *const u8,
        length: u32,
    ) -> i32 {
        assert_eq!(token, 11);
        let mut target = TARGET.lock().unwrap();
        if target.fail_write {
            return -(Errno::ENOSPC as i32);
        }
        if target.reenter {
            assert_eq!(sm_persistent_image_cancel(), -(Errno::EBUSY as i32));
            assert_eq!(
                sm_persistent_image_begin(12, 17, 0, 1),
                -(Errno::EBUSY as i32)
            );
        }
        assert!(length <= DATA_BYTES as u32);
        let count = (length as usize).min(997);
        let start = offset as usize;
        let size = target.bytes.len().max(start + count);
        target.bytes.resize(size, 0);
        let bytes = unsafe { core::slice::from_raw_parts(pointer, count) };
        target.bytes[start..start + count].copy_from_slice(bytes);
        count as i32
    }

    #[unsafe(no_mangle)]
    unsafe extern "C" fn host_image_target_read(
        token: u32,
        offset: i64,
        pointer: *mut u8,
        length: u32,
    ) -> i32 {
        assert_eq!(token, 11);
        let target = TARGET.lock().unwrap();
        if target.fail_read {
            return 0;
        }
        assert!(length <= DATA_BYTES as u32);
        let count = (length as usize).min(1021);
        let start = offset as usize;
        let Some(bytes) = target.bytes.get(start..start + count) else {
            return -(Errno::EIO as i32);
        };
        unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer, count) };
        count as i32
    }

    #[unsafe(no_mangle)]
    extern "C" fn host_image_target_truncate(token: u32, length: i64) -> i32 {
        assert_eq!(token, 11);
        TARGET.lock().unwrap().bytes.resize(length as usize, 0);
        0
    }

    #[unsafe(no_mangle)]
    extern "C" fn host_image_target_flush(token: u32) -> i32 {
        assert_eq!(token, 11);
        let mut target = TARGET.lock().unwrap();
        target.flushes += 1;
        if target.corrupt_flush {
            target.bytes[128 + 7] ^= 1;
        }
        0
    }

    fn reset() {
        assert_eq!(sm_persistent_image_cancel(), 0);
        *TARGET.lock().unwrap() = Target::default();
    }

    fn push(bytes: &[u8]) -> i32 {
        unsafe { sm_persistent_image_push(bytes.as_ptr() as usize, bytes.len()) }
    }

    #[test]
    fn checked_writer_retains_target_and_withholds_identity_until_readback() {
        for policy in [1, 2] {
            reset();
            TARGET.lock().unwrap().reenter = true;
            let bytes: Vec<u8> = (0..DATA_BYTES + 71)
                .map(|index| (index % 251) as u8)
                .collect();
            assert_eq!(
                sm_persistent_image_begin(11, bytes.len() as u32, 0, policy),
                0
            );
            assert_eq!(
                sm_persistent_image_identity_word(0),
                -(Errno::EINVAL as i64)
            );
            for chunk in bytes.chunks(DATA_BYTES) {
                assert_eq!(push(chunk), 0);
            }
            assert_eq!(sm_persistent_image_finish(), 0);
            assert_eq!(TARGET.lock().unwrap().flushes, 1);
            assert_eq!(
                sm_persistent_image_identity_word(0),
                -(Errno::EINVAL as i64)
            );
            assert_eq!(sm_persistent_image_check_step(), DATA_BYTES as i32);
            assert_eq!(
                sm_persistent_image_identity_word(0),
                -(Errno::EINVAL as i64)
            );
            assert_eq!(sm_persistent_image_check_step(), 71);
            assert_eq!(sm_persistent_image_check_step(), 0);
            let mut digest = [0u8; 32];
            for index in 0..8 {
                let word = sm_persistent_image_identity_word(index) as u32;
                digest[index as usize * 4..index as usize * 4 + 4]
                    .copy_from_slice(&word.to_le_bytes());
            }
            assert_ne!(digest, [0; 32]);
            assert_eq!(sm_persistent_image_identity_word(8), bytes.len() as i64);
            let target = TARGET.lock().unwrap();
            assert_eq!(
                sm_persistent_image_identity_word(10),
                target.bytes.len() as i64
            );
            assert_eq!(&target.bytes[128..128 + bytes.len()], bytes);
            drop(target);
            assert_eq!(
                sm_persistent_image_begin(11, 17, 0, policy),
                -(Errno::EBUSY as i32)
            );
            assert_eq!(sm_persistent_image_cancel(), 0);
        }
    }

    #[test]
    fn checked_writer_refuses_damaged_stored_bytes_after_successful_flush() {
        for policy in [1, 2] {
            reset();
            TARGET.lock().unwrap().corrupt_flush = true;
            assert_eq!(sm_persistent_image_begin(11, 31, 0, policy), 0);
            assert_eq!(push(&[19; 31]), 0);
            assert_eq!(sm_persistent_image_finish(), 0);
            assert_eq!(sm_persistent_image_check_step(), -(Errno::EIO as i32));
            assert_eq!(
                sm_persistent_image_identity_word(0),
                -(Errno::EINVAL as i64)
            );
            assert_eq!(sm_persistent_image_cancel(), 0);
        }
    }

    #[test]
    fn checked_writer_preserves_quota_failure_and_requires_explicit_cancel() {
        reset();
        assert_eq!(sm_persistent_image_begin(11, 31, 0, 1), 0);
        TARGET.lock().unwrap().fail_write = true;
        assert_eq!(push(&[19; 31]), -(Errno::ENOSPC as i32));
        assert_eq!(sm_persistent_image_finish(), -(Errno::EINVAL as i32));
        assert_eq!(
            sm_persistent_image_begin(11, 31, 0, 1),
            -(Errno::EBUSY as i32)
        );
        assert_eq!(sm_persistent_image_cancel(), 0);
        TARGET.lock().unwrap().fail_write = false;
        assert_eq!(
            sm_persistent_image_begin(11, 31, 0, 1),
            -(Errno::EINVAL as i32)
        );
        assert_eq!(&TARGET.lock().unwrap().bytes[..128], &[0; 128]);
        assert_eq!(sm_persistent_image_cancel(), 0);
    }

    #[test]
    fn checked_writer_refuses_short_readback_and_invalid_call_order() {
        reset();
        assert_eq!(
            sm_persistent_image_begin(11, 31, 0, 0),
            -(Errno::EINVAL as i32)
        );
        assert_eq!(
            sm_persistent_image_begin(0, 31, 0, 1),
            -(Errno::EINVAL as i32)
        );
        assert_eq!(push(&[1]), -(Errno::EINVAL as i32));
        assert_eq!(sm_persistent_image_finish(), -(Errno::EINVAL as i32));
        assert_eq!(sm_persistent_image_begin(11, 31, 0, 2), 0);
        assert_eq!(push(&[0; 31]), 0);
        assert_eq!(sm_persistent_image_finish(), 0);
        TARGET.lock().unwrap().fail_read = true;
        assert_eq!(sm_persistent_image_check_step(), -(Errno::EIO as i32));
        assert_eq!(
            sm_persistent_image_identity_word(0),
            -(Errno::EINVAL as i64)
        );
        assert_eq!(sm_persistent_image_cancel(), 0);
    }
}
