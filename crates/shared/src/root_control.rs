//! Root launch progression, retained by the actual ProcessTable through startup.
pub mod command {
    pub const BEGIN: u32 = 1;
    pub const POLL: u32 = 2;
    pub const CANCEL: u32 = 3;
    pub const ACK: u32 = 5;
    pub const LAUNCH: u32 = 6;
    pub const PLATFORM_COMPLETED: u32 = 7;
    pub const PLATFORM_FAILED: u32 = 8;
    pub const WORKER_STARTED: u32 = 9;
    pub const WORKER_CANCELLED: u32 = 10;
}
pub mod phase {
    pub const PREPARING: u32 = 1;
    pub const PREPARED: u32 = 2;
    pub const CANCELLING: u32 = 3;
    pub const CANCELLED: u32 = 4;
    pub const LAUNCHING: u32 = 5;
    pub const WAITING: u32 = 6;
    pub const FINISHED: u32 = 7;
    pub const CONTAINED: u32 = 8;
}
pub mod effect {
    pub const PUBLISH_TRANSPORT: u32 = 13;
    pub const BIND_WORKER: u32 = 14;
    pub const REGISTER_PROCESS: u32 = 15;
    pub const CONNECT_IMPORTS: u32 = 16;
    pub const SCHEDULE_START: u32 = 17;
    pub const SEAL_ABSENCE: u32 = 18;
    pub const RETIRE_IMAGE: u32 = 19;
    pub const DISCARD_TRANSPORT: u32 = 20;
    pub const CONTAIN_FAILURE: u32 = 21;
    pub const WAIT_READY: u32 = 22;
    pub const DELIVER_LAUNCH: u32 = 23;
}
pub const EFFECTS: &[(&str, u32)] = &[
    ("publishTransport", effect::PUBLISH_TRANSPORT),
    ("bindWorker", effect::BIND_WORKER),
    ("registerProcess", effect::REGISTER_PROCESS),
    ("connectImports", effect::CONNECT_IMPORTS),
    ("scheduleStart", effect::SCHEDULE_START),
    ("sealAbsence", effect::SEAL_ABSENCE),
    ("retireImage", effect::RETIRE_IMAGE),
    ("discardTransport", effect::DISCARD_TRANSPORT),
    ("containFailure", effect::CONTAIN_FAILURE),
    ("waitReady", effect::WAIT_READY),
    ("deliverLaunch", effect::DELIVER_LAUNCH),
];
