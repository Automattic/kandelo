//! Kernel/host-only foreign-memory storage protocol. No program ABI fields.
use crate::Errno;

pub const REPLY_BYTES: usize = 80;
pub const REPLY_FIELDS: &[(&str, usize)] = &[
    ("receipt", 0),
    ("resource", 32),
    ("root", 40),
    ("replica", 44),
    ("scratch", 48),
    ("maximumPhysicalPages", 52),
    ("maximumVirtualPages", 56),
    ("scratchBytes", 60),
    ("value", 64),
    ("waitAddress", 72),
    ("waitExpected", 76),
];

pub mod status {
    pub const PREPARED: u32 = 1;
    pub const STOPPED: u32 = 2;
    pub const IMAGE_STOPPED: u32 = 4;
    pub const PAUSED: u32 = 8;
    pub const STOPPING: u32 = 16;
    pub const SOURCE_LIVE: u32 = 32;
    pub const IMAGE_UNEXPOSED: u32 = 64;
}

pub mod mapping {
    pub const STAGE: u32 = 1;
    pub const POPULATE: u32 = 2;
    pub const COMMIT: u32 = 3;
    pub const CANCEL: u32 = 4;
}

pub const SNAPSHOT_FIELDS: &[&str] = &[
    "group", "images", "replicas", "exposedReplicas", "quarantinedReplicas",
    "allocatedPages", "pendingWaitDrains", "nativeObservers", "mappingStagingBytes",
    "retainedMappingReferences", "sharedObjects", "sharedPages", "sharedImageReferences",
    "maximumPages", "highWaterPages", "physicalExtentPages",
    "pausedImages", "unacknowledgedReplicas", "waitQueueLock", "waitQueueNodes",
];
pub const SNAPSHOT_BYTES: usize = SNAPSHOT_FIELDS.len() * 4;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Action {
    Describe = 1,
    Publish = 2,
    BeginImagePause = 4,
    ImagePauseAcknowledged = 5,
    ResumeImage = 6,
    StopReplica = 7,
    StopImage = 8,
    NoteQuiescent = 9,
    RevokeSource = 10,
    ReleaseStoppedImage = 11,
    PinNative = 12,
    SettleNative = 13,
    Status = 14,
    PausedExtent = 15,
    Quarantine = 16,
    ReclaimRemoved = 17,
    SweepObjects = 18,
    ProgressBarrier = 19,
    ProgressLocks = 20,
    ProgressPool = 21,
    InspectWait = 22,
    PinChannel = 23,
    PinQueue = 24,
    ContainImage = 25,
}
pub const ACTIONS: &[(&str, Action)] = &[
    ("describe", Action::Describe),
    ("publish", Action::Publish),
    ("beginImagePause", Action::BeginImagePause),
    ("imagePauseAcknowledged", Action::ImagePauseAcknowledged),
    ("resumeImage", Action::ResumeImage),
    ("stopReplica", Action::StopReplica),
    ("stopImage", Action::StopImage),
    ("noteQuiescent", Action::NoteQuiescent),
    ("revokeSource", Action::RevokeSource),
    ("releaseStoppedImage", Action::ReleaseStoppedImage),
    ("pinNative", Action::PinNative),
    ("settleNative", Action::SettleNative),
    ("status", Action::Status),
    ("pausedExtent", Action::PausedExtent),
    ("quarantine", Action::Quarantine),
    ("reclaimRemoved", Action::ReclaimRemoved),
    ("sweepObjects", Action::SweepObjects),
    ("progressBarrier", Action::ProgressBarrier),
    ("progressLocks", Action::ProgressLocks),
    ("progressPool", Action::ProgressPool),
    ("inspectWait", Action::InspectWait),
    ("pinChannel", Action::PinChannel),
    ("pinQueue", Action::PinQueue),
    ("containImage", Action::ContainImage),
];
impl TryFrom<u32> for Action {
    type Error = Errno;
    fn try_from(raw: u32) -> Result<Self, Errno> {
        ACTIONS
            .iter()
            .find_map(|(_, action)| (*action as u32 == raw).then_some(*action))
            .ok_or(Errno::EINVAL)
    }
}
