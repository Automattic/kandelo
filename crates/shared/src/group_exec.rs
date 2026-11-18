//! Kernel-host preparation of an exact future grouped exec image. This is
//! admission/MM metadata only, not a Worker or physical retirement proof.
use crate::{Errno, memory_group::ReceiptRecord};
pub const VERSION: u32 = 1;
pub const CAPABILITY: u32 = 8;
pub const PREPARATION_BYTES: usize = 40;
pub const PREPARATION_FIELDS: &[(&str, usize)] =
    &[("receipt", 0), ("initialPages", 32), ("maximumPages", 36)];
pub const VALIDATE: u32 = 1;
pub const CANCEL: u32 = 2;
pub const FINISH_CANCELLATION: u32 = 3;
pub const ACTIONS: &[(&str, u32)] = &[
    ("validate", VALIDATE),
    ("cancel", CANCEL),
    ("finishCancellation", FINISH_CANCELLATION),
];
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Preparation {
    pub receipt: ReceiptRecord,
    pub initial_pages: u32,
    pub maximum_pages: u32,
}
impl Preparation {
    pub fn encode(self, out: &mut [u8]) -> Result<(), Errno> {
        if out.len() != PREPARATION_BYTES
            || self.receipt.tid != self.receipt.pid
            || self.initial_pages > self.maximum_pages
            || self.maximum_pages == 0
            || self.maximum_pages > 65536
        {
            return Err(Errno::EINVAL);
        }
        self.receipt.encode(&mut out[..32])?;
        out[32..36].copy_from_slice(&self.initial_pages.to_le_bytes());
        out[36..40].copy_from_slice(&self.maximum_pages.to_le_bytes());
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preparation_preserves_full_receipt_and_virtual_bounds_with_exact_capacity() {
        let prepared = Preparation {
            receipt: ReceiptRecord {
                group: 7,
                pid: 100,
                tid: 100,
                serial: u64::MAX,
                generation: 1 << 63,
            },
            initial_pages: 149,
            maximum_pages: 65536,
        };
        let mut bytes = [0; PREPARATION_BYTES];
        prepared.encode(&mut bytes).unwrap();
        assert_eq!(
            ReceiptRecord::decode(&bytes[..32]).unwrap(),
            prepared.receipt
        );
        assert_eq!(u32::from_le_bytes(bytes[32..36].try_into().unwrap()), 149);
        assert_eq!(u32::from_le_bytes(bytes[36..].try_into().unwrap()), 65536);
        assert_eq!(prepared.encode(&mut bytes[..39]), Err(Errno::EINVAL));
        assert_eq!(
            Preparation {
                maximum_pages: 148,
                ..prepared
            }
            .encode(&mut bytes),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            Preparation {
                receipt: ReceiptRecord {
                    tid: 101,
                    ..prepared.receipt
                },
                ..prepared
            }
            .encode(&mut bytes),
            Err(Errno::EINVAL)
        );
    }
}
