//! Exact stopped execution retirement, including actual platform detachment.
pub mod command {
    pub const BEGIN_IMAGE: u32 = 1;
    pub const BEGIN_THREAD: u32 = 2;
    pub const POLL: u32 = 3;
    pub const PLATFORM_DETACHED: u32 = 4;
    pub const ACK: u32 = 5;
    pub const NOTE_WORKER_ABSENCE: u32 = 6;
    pub const PREPARE_DEACTIVATION: u32 = 7;
    pub const BEGIN_STOP: u32 = 8;
    pub const WORKERS_STOPPED: u32 = 9;
    pub const POLL_STOP: u32 = 10;
    pub const ACK_STOP: u32 = 11;
    pub const BIND_REFERENCES: u32 = 12;
    pub const BEGIN_REFERENCES: u32 = 13;
    pub const REFERENCES_DETACHED: u32 = 14;
    pub const WORKER_FENCE: u32 = 15;
    pub const NATIVE_JOIN: u32 = 16;
    pub const SEALED_ABSENCE: u32 = 17;
    pub const WORKER_CONTAINED: u32 = 18;
}
pub const DETACH_PLATFORM: u32 = 14;
pub const DETACH_REFERENCES: u32 = 17;
pub const CANCEL_EXEC_TRANSPORT: u32 = 15;

pub const WAIT_WORKERS: u32 = 16;
pub const PUBLISH_EXIT: u32 = 1;
pub const CONTAIN_WORKER: u32 = 18;
pub const WAIT_THREAD_RETIREMENT: u32 = 19;
pub const JOIN_IMAGE_RETIREMENT: u32 = 20;
pub const WORKER_JOINED: u32 = 1;

pub const NATIVE_JOIN_CAPABILITY: u32 = 1;
pub const STOP_ACCEPTED: u32 = 2;

/// Scalar-only preparation transport. These messages never carry guest memory.
pub const WORKER_MESSAGES: &[(&str, &str)] = &[
    ("prepare", "kandelo.memory-group.worker-prepare.v3"),
    ("ready", "kandelo.memory-group.worker-ready.v3"),
    ("launch", "kandelo.memory-group.worker-launch.v3"),
    ("cancel", "kandelo.memory-group.worker-cancel.v3"),
];
