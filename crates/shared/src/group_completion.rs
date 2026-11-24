//! Kernel-host transport for actual ProcessTable-owned syscall completion.
use crate::{
    Errno,
    memory_group::{RECEIPT_BYTES, ReceiptRecord},
};
pub const REQUEST_BYTES: usize = 80;
pub const REPLY_BYTES: usize = 112;
pub const RETIRE_EXEC_CODE: u32 = 0x4b455852;
pub const RETIRE_EXIT_CODE: u32 = 0x4b455854;
pub const REQUEST_FIELDS: &[(&str, usize)] = &[
    ("receipt", 0),
    ("command", 32),
    ("channel", 36),
    ("token", 40),
    ("observation", 48),
    ("value", 56),
    ("errno", 64),
    ("argument", 68),
];
pub const REPLY_FIELDS: &[(&str, usize)] = &[
    ("effect", 0),
    ("flags", 4),
    ("token", 8),
    ("value", 16),
    ("errno", 24),
    ("channel", 28),
    ("receipt", 32),
    ("resource", 64),
    ("observation", 72),
    ("address", 80),
    ("expected", 84),
    ("syscall", 88),
    ("requestFlags", 92),
    ("delay", 96),
];
pub mod command {
    pub const BIND: u32 = 1;
    pub const CAPTURE: u32 = 2;
    pub const COMPLETE: u32 = 3;
    pub const POLL: u32 = 4;
    pub const DETACH: u32 = 5;
    pub const OBSERVED: u32 = 6;
    pub const ACK: u32 = 7;
    pub const INTERRUPTED: u32 = 8;
    pub const RESUME: u32 = 9;
    pub const SIGNAL: u32 = 10;
    pub const DISPATCH: u32 = 11;
    pub const RETURNED: u32 = 12;
    pub const TERMINAL: u32 = 13;
}
pub const COMMANDS: &[(&str, u32)] = &[
    ("bind", command::BIND),
    ("capture", command::CAPTURE),
    ("complete", command::COMPLETE),
    ("poll", command::POLL),
    ("detach", command::DETACH),
    ("observed", command::OBSERVED),
    ("ack", command::ACK),
    ("interrupted", command::INTERRUPTED),
    ("resume", command::RESUME),
    ("signal", command::SIGNAL),
    ("dispatch", command::DISPATCH),
    ("returned", command::RETURNED),
    ("terminal", command::TERMINAL),
];
pub mod effect {
    pub const CAPTURED: u32 = 1;
    pub const INTERRUPT: u32 = 2;
    pub const STOPPED: u32 = 3;
    pub const OBSERVE: u32 = 4;
    pub const CANCEL_OBSERVATION: u32 = 5;
    pub const PUBLISHED: u32 = 6;
    pub const DISCARDED: u32 = 7;
    pub const FATAL: u32 = 8;
    pub const ACKNOWLEDGED: u32 = 9;
    pub const RESUMED: u32 = 10;
    pub const SIGNAL: u32 = 11;
    pub const RETRY: u32 = 12;
    pub const DISPATCH: u32 = 13;
}
pub const EFFECTS: &[(&str, u32)] = &[
    ("captured", effect::CAPTURED),
    ("interrupt", effect::INTERRUPT),
    ("stopped", effect::STOPPED),
    ("observe", effect::OBSERVE),
    ("cancelObservation", effect::CANCEL_OBSERVATION),
    ("published", effect::PUBLISHED),
    ("discarded", effect::DISCARDED),
    ("fatal", effect::FATAL),
    ("acknowledged", effect::ACKNOWLEDGED),
    ("resumed", effect::RESUMED),
    ("signal", effect::SIGNAL),
    ("retry", effect::RETRY),
    ("dispatch", effect::DISPATCH),
];
pub mod flags {
    pub const RELISTEN: u32 = 1;
    pub const TERMINAL: u32 = 2;
    pub const AUTOMATIC: u32 = 4;
    pub const INVALID: u32 = 8;
}
#[derive(Clone, Copy, Debug)]
pub struct Request {
    pub receipt: ReceiptRecord,
    pub command: u32,
    pub channel: u32,
    pub token: u64,
    pub observation: u64,
    pub value: i64,
    pub errno: u32,
    pub argument: u32,
}
impl Request {
    pub fn decode(bytes: &[u8]) -> Result<Self, Errno> {
        if bytes.len() != REQUEST_BYTES || bytes[72..].iter().any(|byte| *byte != 0) {
            return Err(Errno::EINVAL);
        }
        let word = |at| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        let wide = |at| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
        let request = Self {
            receipt: ReceiptRecord::decode(&bytes[..RECEIPT_BYTES])?,
            command: word(32),
            channel: word(36),
            token: wide(40),
            observation: wide(48),
            value: wide(56) as i64,
            errno: word(64),
            argument: word(68),
        };
        use command as C;
        if !(C::BIND..=C::TERMINAL).contains(&request.command)
            || request.command != C::BIND && request.channel != 0
            || request.command == C::BIND && (request.channel == 0 || request.channel % 4 != 0)
            || matches!(
                request.command,
                C::BIND | C::CAPTURE | C::DETACH | C::RESUME
            ) && request.token != 0
            || matches!(
                request.command,
                C::COMPLETE | C::POLL | C::OBSERVED | C::ACK | C::INTERRUPTED | C::SIGNAL | C::DISPATCH | C::RETURNED
            ) && request.token == 0
            || request.command != C::OBSERVED && request.observation != 0
            || request.command == C::OBSERVED && request.observation == 0
            || request.command != C::COMPLETE && (request.value != 0 || request.errno != 0)
            || request.errno > 4095
            || !matches!(request.command, C::INTERRUPTED | C::SIGNAL) && request.argument != 0
            || request.argument > 1
        {
            return Err(Errno::EINVAL);
        }
        Ok(request)
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Reply {
    pub receipt: ReceiptRecord,
    pub effect: u32,
    pub flags: u32,
    pub token: u64,
    pub value: i64,
    pub errno: u32,
    pub channel: u32,
    pub resource: u64,
    pub observation: u64,
    pub address: u32,
    pub expected: u32,
    pub syscall: u32,
    pub request_flags: u32,
    pub delay: u32,
}
impl Reply {
    pub fn new(receipt: ReceiptRecord, token: u64, effect: u32) -> Self {
        Self {
            receipt,
            effect,
            flags: 0,
            token,
            value: 0,
            errno: 0,
            channel: 0,
            resource: 0,
            observation: 0,
            address: 0,
            expected: 0,
            syscall: 0,
            request_flags: 0,
            delay: 0,
        }
    }
    pub fn encode(&self, bytes: &mut [u8]) -> Result<(), Errno> {
        if bytes.len() != REPLY_BYTES {
            return Err(Errno::EINVAL);
        }
        bytes.fill(0);
        self.receipt.encode(&mut bytes[32..64])?;
        for (at, value) in [
            (0, self.effect),
            (4, self.flags),
            (24, self.errno),
            (28, self.channel),
            (80, self.address),
            (84, self.expected),
            (88, self.syscall),
            (92, self.request_flags),
            (96, self.delay),
        ] {
            bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
        }
        for (at, value) in [
            (8, self.token),
            (16, self.value as u64),
            (64, self.resource),
            (72, self.observation),
        ] {
            bytes[at..at + 8].copy_from_slice(&value.to_le_bytes());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(command: u32) -> [u8; REQUEST_BYTES] {
        let mut bytes = [0; REQUEST_BYTES];
        ReceiptRecord {
            group: 1,
            pid: 2,
            tid: 3,
            serial: 4,
            generation: 5,
        }
        .encode(&mut bytes[..RECEIPT_BYTES])
        .unwrap();
        bytes[32..36].copy_from_slice(&command.to_le_bytes());
        bytes
    }

    #[test]
    fn completion_frame_rejects_unknown_or_contradictory_fields_before_dispatch() {
        let mut valid = frame(command::CAPTURE);
        assert!(Request::decode(&valid).is_ok());
        assert!(Request::decode(&valid[..REQUEST_BYTES - 1]).is_err());
        for (offset, value) in [
            (12, 1),
            (32, 99),
            (36, 4),
            (40, 1),
            (48, 1),
            (56, 1),
            (64, 1),
            (68, 1),
            (72, 1),
            (79, 1),
        ] {
            valid[offset] = value;
            assert!(
                matches!(Request::decode(&valid), Err(Errno::EINVAL)),
                "offset {offset}"
            );
            valid = frame(command::CAPTURE);
        }
        for command in [
            command::COMPLETE,
            command::POLL,
            command::OBSERVED,
            command::ACK,
            command::INTERRUPTED,
        ] {
            assert!(
                Request::decode(&frame(command)).is_err(),
                "missing token for {command}"
            );
        }
        let mut bind = frame(command::BIND);
        for channel in [0u32, 1, 65537] {
            bind[36..40].copy_from_slice(&channel.to_le_bytes());
            assert!(Request::decode(&bind).is_err());
        }
        bind[36..40].copy_from_slice(&65536u32.to_le_bytes());
        assert!(Request::decode(&bind).is_ok());
    }

    #[test]
    fn completion_wire_preserves_signed_i64_and_unsigned_identities() {
        for value in [i64::MIN, -1, 0, 0x1234567800000042, i64::MAX] {
            let mut bytes = frame(command::COMPLETE);
            bytes[40..48].copy_from_slice(&u64::MAX.to_le_bytes());
            bytes[56..64].copy_from_slice(&value.to_le_bytes());
            let decoded = Request::decode(&bytes).unwrap();
            assert_eq!((decoded.value, decoded.token), (value, u64::MAX));
            let mut reply = Reply::new(decoded.receipt, decoded.token, effect::PUBLISHED);
            reply.value = value;
            let mut output = [0xff; REPLY_BYTES];
            reply.encode(&mut output).unwrap();
            assert_eq!(
                i64::from_le_bytes(output[16..24].try_into().unwrap()),
                value
            );
            assert_eq!(
                u64::from_le_bytes(output[8..16].try_into().unwrap()),
                u64::MAX
            );
            assert!(output[100..].iter().all(|byte| *byte == 0));
        }
    }
}
