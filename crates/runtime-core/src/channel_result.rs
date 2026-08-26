use wasm_posix_shared::Errno;

/// One syscall result as observed through the authoritative channel and the
/// legacy narrow export return.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ChannelDispatchOutcome {
    pub channel_result: i64,
    pub channel_errno: u32,
    pub export_result: i32,
}

impl ChannelDispatchOutcome {
    pub fn narrow(result: i32) -> Self {
        let (channel_result, channel_errno) = encode_channel_result(i64::from(result));
        Self {
            channel_result,
            channel_errno,
            export_result: result,
        }
    }

    pub fn exact(result: i64) -> Self {
        let (channel_result, channel_errno) = encode_channel_result(result);
        Self {
            channel_result,
            channel_errno,
            // WHY: preserve the existing exported i32 signature and its
            // low-word mirror. Callers needing the syscall value must read
            // the generated i64 channel field, as the host runtime does.
            export_result: result as i32,
        }
    }

    pub fn process_address(result: Result<usize, Errno>) -> Self {
        match result {
            Ok(address) => {
                let Ok(bits) = u64::try_from(address) else {
                    return Self::exact(-(Errno::EOVERFLOW as i64));
                };
                Self {
                    // WHY: wasm64 pointers are unsigned. Preserve all 64 bits
                    // in the physical i64 channel word; channel_errno keeps a
                    // bit-63 address distinguishable from a negated errno.
                    channel_result: bits as i64,
                    channel_errno: 0,
                    export_result: bits as u32 as i32,
                }
            }
            Err(error) => Self::exact(-(error as i64)),
        }
    }
}

pub fn encode_channel_result(result: i64) -> (i64, u32) {
    if result >= 0 {
        return (result, 0);
    }
    let errno = result
        .checked_neg()
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(Errno::EIO as u32);
    (-1, errno)
}

pub fn checked_mmap_byte_offset(page_offset: i64) -> Result<i64, Errno> {
    if page_offset < 0 {
        return Err(Errno::EINVAL);
    }
    page_offset.checked_mul(4096).ok_or(Errno::EOVERFLOW)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_outcome_keeps_values_wider_than_i32_and_number() {
        for result in [i64::from(i32::MAX) + 1, (1i64 << 53) + 1, i64::MAX] {
            let outcome = ChannelDispatchOutcome::exact(result);
            assert_eq!(outcome.channel_result, result);
            assert_eq!(outcome.channel_errno, 0);
            assert_eq!(outcome.export_result, result as i32);
            assert_eq!(encode_channel_result(outcome.channel_result), (result, 0));
        }

        let error = -(Errno::EINVAL as i64);
        let outcome = ChannelDispatchOutcome::exact(error);
        assert_eq!(outcome.channel_result, -1);
        assert_eq!(outcome.channel_errno, Errno::EINVAL as u32);
        assert_eq!(outcome.export_result, -(Errno::EINVAL as i32));
    }

    #[test]
    fn process_address_keeps_unsigned_wasm64_bits_distinct_from_errno() {
        if usize::BITS == 64 {
            for address in [
                0x1_0000_0000usize,
                (1usize << 63) | 0x1234,
                usize::MAX,
            ] {
                let outcome = ChannelDispatchOutcome::process_address(Ok(address));
                assert_eq!(outcome.channel_result as u64, address as u64);
                assert_eq!(outcome.channel_errno, 0);
                assert_eq!(outcome.export_result, address as u32 as i32);
            }
        }

        let outcome = ChannelDispatchOutcome::process_address(Err(Errno::EINVAL));
        assert_eq!(outcome.channel_result, -1);
        assert_eq!(outcome.channel_errno, Errno::EINVAL as u32);
        assert_eq!(outcome.export_result, -(Errno::EINVAL as i32));
    }

    #[test]
    fn mmap_page_offsets_are_lossless_or_rejected_before_shifting() {
        assert_eq!(checked_mmap_byte_offset(0), Ok(0));
        assert_eq!(
            checked_mmap_byte_offset(i64::from(u32::MAX)),
            Ok(i64::from(u32::MAX) * 4096),
        );
        assert_eq!(
            checked_mmap_byte_offset(0x1_0000_0001),
            Ok(0x1_0000_0001_000),
        );

        let largest_page_offset = i64::MAX / 4096;
        assert_eq!(
            checked_mmap_byte_offset(largest_page_offset),
            Ok(largest_page_offset * 4096),
        );
        assert_eq!(
            checked_mmap_byte_offset(largest_page_offset + 1),
            Err(Errno::EOVERFLOW),
        );
        assert_eq!(checked_mmap_byte_offset(-1), Err(Errno::EINVAL));
    }
}
