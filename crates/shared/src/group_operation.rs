//! Kernel-host operation driver. Guest programs do not consume these records.
use crate::{Errno, memory_group::ReceiptRecord};
pub mod layout;

pub const REQUEST_BYTES: usize = 384;
pub const REPLY_BYTES: usize = 512;
pub const PAYLOAD_BYTES: usize = 320;
pub const REQUEST_FIELDS: &[(&str, usize)] = &[
    ("kind", 0),
    ("syscall", 4),
    ("args", 8),
    ("thread", 56),
    ("reserved", 60),
    ("payload", 64),
];
pub const REPLY_FIELDS: &[(&str, usize)] = &[
    ("effect", 0),
    ("flags", 4),
    ("operation", 8),
    ("value", 16),
    ("errno", 24),
    ("delay", 28),
    ("waitToken", 32),
    ("waitAddress", 40),
    ("waitExpected", 44),
    ("receipt", 48),
    ("storage", 80),
    ("payloadBytes", 160),
    ("length", 164),
    ("payload", 168),
];
pub mod command {
    pub const BEGIN: u32 = 1;
    pub const POLL: u32 = 2;
    pub const CANCEL: u32 = 3;
    pub const ACK: u32 = 4;
    pub const THREAD_BOUND: u32 = 5;
    pub const THREAD_DETACHED: u32 = 6;
    pub const FORK_LAUNCHED: u32 = 7;
    pub const FORK_IMAGE_RETIRED: u32 = 8;
    pub const FORK_DETACHED: u32 = 9;
    pub const FORK_NATIVE_POLL: u32 = 10;
    pub const FORK_NATIVE_ENTERED: u32 = 11;
    pub const FORK_NATIVE_COMPLETED: u32 = 12;
    pub const FORK_NATIVE_FAILED: u32 = 13;
    pub const FORK_NATIVE_TIMEOUT: u32 = 14;
    pub const FORK_NATIVE_PROTOCOL_FAILED: u32 = 15;
    pub const FORK_NATIVE_NO_MEMORY: u32 = 16;
    pub const FORK_NATIVE_CONSTRUCTOR_UNKNOWN: u32 = 17;
    pub const FORK_NATIVE_VALIDATE: u32 = 18;
    pub const FORK_NATIVE_NOT_APPLIED: u32 = 19;
    pub const FORK_SETUP_FAILED: u32 = 20;
    pub const FORK_SETUP_NO_MEMORY: u32 = 21;
    pub const THREAD_BINDING_FAILED: u32 = 22;
    pub const THREAD_BINDING_NO_MEMORY: u32 = 23;
    pub const THREAD_BINDING_ENTER: u32 = 24;
}
pub mod kind {
    pub const MAPPING: u32 = 1;
    pub const OWNED_MAPPING: u32 = 3;
    pub const THREAD_PREPARE: u32 = 4;
    pub const FORK: u32 = 5;
    /// Complete clone operation, opened before the kernel allocates its task.
    pub const CLONE: u32 = 6;
    pub const fn is_thread(value: u32) -> bool {
        matches!(value, THREAD_PREPARE | CLONE)
    }
}
pub mod effect {
    pub const COMPLETE: u32 = 1;
    pub const WAIT_NATIVE: u32 = 2;
    pub const YIELD: u32 = 3;
    pub const WAIT_OPERATION: u32 = 4;
    pub const PREPARE_THREAD_BINDING: u32 = 5;
    pub const DETACH_THREAD_BINDING: u32 = 6;
    pub const KERNEL_THREAD_EXIT: u32 = 7;
    pub const FORK_LAUNCH: u32 = 8;
    pub const FORK_RETIRE_TRANSPORT: u32 = 9;
    pub const FORK_REMOVE_TRANSPORT: u32 = 10;
    pub const KERNEL_FORK_CREATE: u32 = 11;
    pub const KERNEL_FORK_REMOVE: u32 = 12;
    pub const FORK_OBJECTS: u32 = 24;
    pub const FORK_PUBLISH: u32 = 25;
    pub const FORK_BIND: u32 = 26;
    pub const FORK_REGISTER: u32 = 27;
    pub const FORK_CONNECT: u32 = 28;
    pub const FORK_START: u32 = 29;
    pub const FORK_READY: u32 = 30;
    pub const FORK_DELIVER: u32 = 31;
    pub const FORK_REPLAY: u32 = 32;
    pub const FORK_RUNTIME: u32 = 33;
    pub const FORK_CANCEL_NATIVE: u32 = 34;
    pub const FORK_SEAL: u32 = 35;
    pub const FORK_WAIT_STOP: u32 = 36;
    pub const FORK_CONTAIN: u32 = 37;
    pub const FORK_REFERENCES: u32 = 38;
    pub const FORK_DEACTIVATE: u32 = 39;
    pub const FORK_DISPOSE: u32 = 40;
    pub const FORK_SUCCEEDED: u32 = 41;
    pub const FORK_FAILED: u32 = 42;
    pub const FORK_FATAL: u32 = 43;
}
pub mod flags {
    pub const DELIVER: u32 = 1;
    pub const OWNED_PACKET: u32 = 2;
    pub const THREAD_RETIRED: u32 = 8;
    pub const THREAD_EXECUTION: u32 = 16;
    pub const NATIVE_EXECUTE: u32 = 32;
    pub const NATIVE_PENDING: u32 = 64;
}
pub const TRANSPORT_GONE: u32 = 1 << 31;

#[derive(Clone, Copy)]
pub struct Request {
    pub kind: u32,
    pub syscall: u32,
    pub args: [u64; 6],
    pub thread: u32,
}
impl Request {
    pub fn decode(bytes: &[u8]) -> Result<Self, Errno> {
        if bytes.len() != REQUEST_BYTES || bytes[60..64] != [0; 4] {
            return Err(Errno::EINVAL);
        }
        let word = |at| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        let request = Self {
            kind: word(0),
            syscall: word(4),
            args: core::array::from_fn(|at| {
                u64::from_le_bytes(bytes[8 + at * 8..16 + at * 8].try_into().unwrap())
            }),
            thread: word(56),
        };
        if !matches!(
            request.kind,
            kind::MAPPING | kind::OWNED_MAPPING | kind::THREAD_PREPARE | kind::FORK | kind::CLONE
        ) || request.kind != kind::THREAD_PREPARE && request.thread != 0
            || request.kind != kind::OWNED_MAPPING && bytes[64..].iter().any(|byte| *byte != 0)
        {
            return Err(Errno::EINVAL);
        }
        Ok(request)
    }
}

pub struct Reply {
    pub effect: u32,
    pub flags: u32,
    pub operation: u64,
    pub value: i64,
    pub errno: u32,
    pub delay: u32,
    pub wait_token: u64,
    pub wait_address: u32,
    pub wait_expected: u32,
    pub receipt: ReceiptRecord,
    pub storage: [u8; 80],
    pub payload: [u8; PAYLOAD_BYTES],
    pub payload_bytes: u32,
    pub length: u32,
}
impl Reply {
    pub fn new(receipt: ReceiptRecord, operation: u64, effect: u32) -> Self {
        Self {
            effect,
            flags: flags::DELIVER,
            operation,
            value: 0,
            errno: 0,
            delay: 0,
            wait_token: 0,
            wait_address: 0,
            wait_expected: 0,
            receipt,
            storage: [0; 80],
            payload: [0; PAYLOAD_BYTES],
            payload_bytes: 0,
            length: 0,
        }
    }
    pub fn encode(&self, bytes: &mut [u8]) -> Result<(), Errno> {
        if bytes.len() != REPLY_BYTES || self.payload_bytes as usize > PAYLOAD_BYTES {
            return Err(Errno::EINVAL);
        }
        bytes.fill(0);
        for (at, value) in [
            (0, self.effect),
            (4, self.flags),
            (24, self.errno),
            (28, self.delay),
            (40, self.wait_address),
            (44, self.wait_expected),
            (160, self.payload_bytes),
            (164, self.length),
        ] {
            bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
        }
        bytes[8..16].copy_from_slice(&self.operation.to_le_bytes());
        bytes[16..24].copy_from_slice(&self.value.to_le_bytes());
        bytes[32..40].copy_from_slice(&self.wait_token.to_le_bytes());
        self.receipt.encode(&mut bytes[48..80])?;
        bytes[80..160].copy_from_slice(&self.storage);
        bytes[168..168 + self.payload_bytes as usize]
            .copy_from_slice(&self.payload[..self.payload_bytes as usize]);
        Ok(())
    }
}

pub const FORK_NATIVE_EFFECTS: &[(&str, u32)] = &[
    ("forkObjects", effect::FORK_OBJECTS),
    ("forkPublish", effect::FORK_PUBLISH),
    ("forkBind", effect::FORK_BIND),
    ("forkRegister", effect::FORK_REGISTER),
    ("forkConnect", effect::FORK_CONNECT),
    ("forkStart", effect::FORK_START),
    ("forkReady", effect::FORK_READY),
    ("forkDeliver", effect::FORK_DELIVER),
    ("forkReplay", effect::FORK_REPLAY),
    ("forkRuntime", effect::FORK_RUNTIME),
    ("forkCancelNative", effect::FORK_CANCEL_NATIVE),
    ("forkSeal", effect::FORK_SEAL),
    ("forkWaitStop", effect::FORK_WAIT_STOP),
    ("forkContain", effect::FORK_CONTAIN),
    ("forkReferences", effect::FORK_REFERENCES),
    ("forkDeactivate", effect::FORK_DEACTIVATE),
    ("forkDispose", effect::FORK_DISPOSE),
    ("forkSucceeded", effect::FORK_SUCCEEDED),
    ("forkFailed", effect::FORK_FAILED),
    ("forkFatal", effect::FORK_FATAL),
];

pub const COMMANDS: &[(&str, u32)] = &[
    ("begin", command::BEGIN),
    ("poll", command::POLL),
    ("cancel", command::CANCEL),
    ("ack", command::ACK),
    ("threadBound", command::THREAD_BOUND),
    ("threadDetached", command::THREAD_DETACHED),
    ("forkLaunched", command::FORK_LAUNCHED),
    ("forkImageRetired", command::FORK_IMAGE_RETIRED),
    ("forkDetached", command::FORK_DETACHED),
    ("forkNativePoll", command::FORK_NATIVE_POLL),
    ("forkNativeEntered", command::FORK_NATIVE_ENTERED),
    ("forkNativeCompleted", command::FORK_NATIVE_COMPLETED),
    ("forkNativeFailed", command::FORK_NATIVE_FAILED),
    ("forkNativeTimeout", command::FORK_NATIVE_TIMEOUT),
    (
        "forkNativeProtocolFailed",
        command::FORK_NATIVE_PROTOCOL_FAILED,
    ),
    ("forkNativeNoMemory", command::FORK_NATIVE_NO_MEMORY),
    (
        "forkNativeConstructorUnknown",
        command::FORK_NATIVE_CONSTRUCTOR_UNKNOWN,
    ),
    ("forkNativeValidate", command::FORK_NATIVE_VALIDATE),
    ("forkNativeNotApplied", command::FORK_NATIVE_NOT_APPLIED),
    ("forkSetupFailed", command::FORK_SETUP_FAILED),
    ("forkSetupNoMemory", command::FORK_SETUP_NO_MEMORY),
    ("threadBindingFailed", command::THREAD_BINDING_FAILED),
    ("threadBindingNoMemory", command::THREAD_BINDING_NO_MEMORY),
    ("threadBindingEnter", command::THREAD_BINDING_ENTER),
];

pub const DRIVER_EFFECTS: &[(&str, u32)] = &[
    ("complete", effect::COMPLETE),
    ("native", effect::WAIT_NATIVE),
    ("yield", effect::YIELD),
    ("operation", effect::WAIT_OPERATION),
    ("prepareThreadBinding", effect::PREPARE_THREAD_BINDING),
    ("detachThreadBinding", effect::DETACH_THREAD_BINDING),
    ("forkLaunch", effect::FORK_LAUNCH),
    ("forkRetireTransport", effect::FORK_RETIRE_TRANSPORT),
    ("forkRemoveTransport", effect::FORK_REMOVE_TRANSPORT),
];

pub const NATIVE_EVENT_RECORD_LIMIT: u32 = 64;
