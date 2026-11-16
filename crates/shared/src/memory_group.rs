//! Kernel-host memory-group metadata. No guest syscall or program ABI fields.
use crate::Errno;

pub const PROTOCOL_VERSION: u32 = 1;
/// Admission is available before the execution backend/stop protocol is wired.
pub const CAPABILITY_ADMISSION: u32 = 1;
pub const RECEIPT_BYTES: usize = 32;
pub const SNAPSHOT_BYTES: usize = 40;

pub const RECEIPT_GROUP: usize = 0;
pub const RECEIPT_PID: usize = 4;
pub const RECEIPT_TID: usize = 8;
pub const RECEIPT_RESERVED: usize = 12;
pub const RECEIPT_SERIAL: usize = 16;
pub const RECEIPT_GENERATION: usize = 24;

pub const RECEIPT_FIELDS: &[(&str, usize)] = &[
    ("group", RECEIPT_GROUP),
    ("pid", RECEIPT_PID),
    ("tid", RECEIPT_TID),
    ("reserved", RECEIPT_RESERVED),
    ("serial", RECEIPT_SERIAL),
    ("generation", RECEIPT_GENERATION),
];
pub const SNAPSHOT_FIELDS: &[(&str, usize)] = &[
    ("group", 0),
    ("maximumPages", 4),
    ("maximumProcesses", 8),
    ("maximumTasks", 12),
    ("accepting", 16),
    ("processes", 20),
    ("tasks", 24),
    ("quarantinedTasks", 28),
    ("backings", 32),
    ("images", 36),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum TaskAction {
    Start = 1,
    BeginRetirement = 2,
    RetireQuiescent = 3,
    Quarantine = 4,
    CancelUnconstructed = 5,
}
impl TryFrom<u32> for TaskAction {
    type Error = Errno;
    fn try_from(value: u32) -> Result<Self, Errno> {
        match value {
            1 => Ok(Self::Start),
            2 => Ok(Self::BeginRetirement),
            3 => Ok(Self::RetireQuiescent),
            4 => Ok(Self::Quarantine),
            5 => Ok(Self::CancelUnconstructed),
            _ => Err(Errno::EINVAL),
        }
    }
}
pub const TASK_ACTIONS: &[(&str, TaskAction)] = &[
    ("start", TaskAction::Start),
    ("beginRetirement", TaskAction::BeginRetirement),
    ("retireQuiescent", TaskAction::RetireQuiescent),
    ("quarantine", TaskAction::Quarantine),
    ("cancelUnconstructed", TaskAction::CancelUnconstructed),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReceiptRecord {
    pub group: u32,
    pub pid: u32,
    pub tid: u32,
    pub serial: u64,
    pub generation: u64,
}

impl ReceiptRecord {
    fn validate(&self) -> Result<(), Errno> {
        if self.group == 0 || self.pid == 0 || self.tid == 0 || self.serial == 0 {
            Err(Errno::EINVAL)
        } else {
            Ok(())
        }
    }
    pub fn encode(&self, out: &mut [u8]) -> Result<(), Errno> {
        if out.len() != RECEIPT_BYTES {
            return Err(Errno::EINVAL);
        }
        self.validate()?;
        out[RECEIPT_GROUP..RECEIPT_GROUP + 4].copy_from_slice(&self.group.to_le_bytes());
        out[RECEIPT_PID..RECEIPT_PID + 4].copy_from_slice(&self.pid.to_le_bytes());
        out[RECEIPT_TID..RECEIPT_TID + 4].copy_from_slice(&self.tid.to_le_bytes());
        out[RECEIPT_RESERVED..RECEIPT_RESERVED + 4].fill(0);
        out[RECEIPT_SERIAL..RECEIPT_SERIAL + 8].copy_from_slice(&self.serial.to_le_bytes());
        out[RECEIPT_GENERATION..RECEIPT_GENERATION + 8]
            .copy_from_slice(&self.generation.to_le_bytes());
        Ok(())
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, Errno> {
        if bytes.len() != RECEIPT_BYTES {
            return Err(Errno::EINVAL);
        }
        let word = |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
        let wide = |offset| u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
        if word(RECEIPT_RESERVED) != 0 {
            return Err(Errno::EINVAL);
        }
        let record = Self {
            group: word(RECEIPT_GROUP),
            pid: word(RECEIPT_PID),
            tid: word(RECEIPT_TID),
            serial: wide(RECEIPT_SERIAL),
            generation: wide(RECEIPT_GENERATION),
        };
        record.validate()?;
        Ok(record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_unsigned_identities_have_no_negative_errno_alias() {
        let record = ReceiptRecord {
            group: 4,
            pid: 100,
            tid: 101,
            serial: u64::MAX,
            generation: u64::MAX,
        };
        let mut bytes = [0xab; RECEIPT_BYTES];
        record.encode(&mut bytes).unwrap();
        assert_eq!(ReceiptRecord::decode(&bytes), Ok(record));
        assert_eq!(&bytes[RECEIPT_RESERVED..RECEIPT_RESERVED + 4], &[0; 4]);
    }
    #[test]
    fn malformed_receipts_cannot_reinterpret_padding_or_truncated_identity() {
        let record = ReceiptRecord {
            group: 1,
            pid: 100,
            tid: 100,
            serial: 1,
            generation: 0,
        };
        let mut bytes = [0; RECEIPT_BYTES];
        record.encode(&mut bytes).unwrap();
        bytes[RECEIPT_RESERVED] = 1;
        assert_eq!(ReceiptRecord::decode(&bytes), Err(Errno::EINVAL));
        assert_eq!(
            ReceiptRecord::decode(&bytes[..RECEIPT_BYTES - 1]),
            Err(Errno::EINVAL)
        );
        bytes[RECEIPT_RESERVED] = 0;
        bytes[RECEIPT_SERIAL..RECEIPT_SERIAL + 8].fill(0);
        assert_eq!(ReceiptRecord::decode(&bytes), Err(Errno::EINVAL));
    }
    #[test]
    fn refused_encoding_preserves_destination_and_actions_are_explicit() {
        let mut bytes = [0xab; RECEIPT_BYTES];
        let invalid = ReceiptRecord {
            group: 0,
            pid: 100,
            tid: 100,
            serial: 1,
            generation: 0,
        };
        assert_eq!(invalid.encode(&mut bytes), Err(Errno::EINVAL));
        assert_eq!(bytes, [0xab; RECEIPT_BYTES]);
        assert_eq!(TaskAction::try_from(0), Err(Errno::EINVAL));
        assert_eq!(TaskAction::try_from(6), Err(Errno::EINVAL));
    }
}
