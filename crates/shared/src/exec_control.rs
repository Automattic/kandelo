//! Kernel-owned grouped-exec lifecycle. Reuses the copied operation reply wire.
pub mod command {
    pub const BEGIN: u32 = 1;
    pub const POLL: u32 = 2;
    pub const CANCEL: u32 = 3;
    pub const VALIDATE: u32 = 4;
    pub const HANDOFF: u32 = 5;
    pub const VALIDATE_INSTALL: u32 = 9;
    pub const INSTALLED: u32 = 10;
    pub const ACK: u32 = 13;
    pub const STATUS: u32 = 14;
    pub const PLATFORM_COMPLETED: u32 = 15;
    pub const PLATFORM_FAILED: u32 = 16;
}
pub mod phase {
    pub const PREPARING: u32 = 1;
    pub const PREPARED: u32 = 2;
    pub const COMMITTED: u32 = 3;
    pub const HANDOFF: u32 = 4;
    pub const OLD_STOPPED: u32 = 5;
    pub const CANCELLING: u32 = 6;
    pub const CANCELLED: u32 = 7;
    pub const TERMINATING: u32 = 8;
    pub const TERMINATED_FUTURE: u32 = 9;
    pub const INSTALLED: u32 = 10;
    pub const FINISHED: u32 = 11;
    pub const CONTAINED: u32 = 12;
}
/// Every effect is issued at most once per exact future receipt. Completion
/// reports must name the currently outstanding effect; a late duplicate cannot
/// advance the next phase or supply stop/reference retirement proof.
pub mod effect {
    pub const WAIT_WORKERS: u32 = 13;
    pub const DETACH_PREVIOUS: u32 = 14;
    pub const JOIN_PREVIOUS: u32 = 15;
    pub const INSTALL_REPLACEMENT: u32 = 16;
    pub const RETIRE_PREVIOUS: u32 = 17;
    pub const BIND_REPLACEMENT: u32 = 18;
    pub const START_REPLACEMENT: u32 = 19;
    pub const DISCARD_FUTURE: u32 = 20;
    pub const PUBLISH_TERMINATION: u32 = 21;
    pub const FINISH_HANDOFF: u32 = 22;
    pub const CONTAIN_FAILURE: u32 = 23;
}
pub const EFFECTS: &[(&str, u32)] = &[
    ("waitWorkers", effect::WAIT_WORKERS),
    ("detachPrevious", effect::DETACH_PREVIOUS),
    ("joinPrevious", effect::JOIN_PREVIOUS),
    ("installReplacement", effect::INSTALL_REPLACEMENT),
    ("retirePrevious", effect::RETIRE_PREVIOUS),
    ("bindReplacement", effect::BIND_REPLACEMENT),
    ("startReplacement", effect::START_REPLACEMENT),
    ("discardFuture", effect::DISCARD_FUTURE),
    ("publishTermination", effect::PUBLISH_TERMINATION),
    ("finishHandoff", effect::FINISH_HANDOFF),
    ("containFailure", effect::CONTAIN_FAILURE),
];
pub const LAYOUT_FIELDS: &[(&str, usize)] = &[
    ("initialPages", 0),
    ("maximumPages", 8),
    ("controlBase", 16),
    ("controlEnd", 24),
    ("channelOffset", 32),
    ("channelPage", 40),
    ("brkBase", 48),
    ("mmapBase", 56),
    ("brkLimit", 64),
    ("maxAddr", 72),
    ("firstThreadSlotPage", 80),
    ("firstThreadBasePage", 88),
    ("threadArenaEndPage", 96),
    ("threadSlotCount", 104),
];
pub const SOURCE: usize = 112;
pub const PARENT: usize = 144;
pub const SIGNAL: usize = 148;
