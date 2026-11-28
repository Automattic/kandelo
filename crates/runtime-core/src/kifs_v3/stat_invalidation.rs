//! Bounded in-memory generations for authenticated pathname and inode results.
use super::{Edit, Key, decode_key, prefix_end};
use crate::rootfs::StatStamp;
use wasm_posix_shared::mode::{S_IFMT, S_IFREG};

use wasm_posix_shared::stat_cache_wire::INODE_BUCKETS as BUCKETS;

fn bucket(inode: u64) -> usize {
    let mixed = inode ^ (inode >> 8) ^ (inode >> 32);
    mixed as usize & (BUCKETS - 1)
}

pub(super) struct Generations {
    pathname: u64,
    inodes: [u64; BUCKETS],
}

impl Generations {
    pub(super) const fn new() -> Self {
        Self {
            pathname: 0,
            inodes: [0; BUCKETS],
        }
    }

    pub(super) fn stamp(&self, route: u64, inode: u64) -> StatStamp {
        StatStamp {
            route,
            pathname: self.pathname,
            inode: self.inodes[bucket(inode)],
        }
    }

    pub(super) fn commit(&mut self, changes: Changes, revision: u64) {
        if changes.pathname {
            self.pathname = revision;
        }
        for (word, mut selected) in changes.inodes.into_iter().enumerate() {
            while selected != 0 {
                let bit = selected.trailing_zeros() as usize;
                self.inodes[word * 64 + bit] = revision;
                selected &= selected - 1;
            }
        }
    }
}

#[derive(Clone, Copy, Default)]
pub(super) struct Changes {
    pathname: bool,
    inodes: [u64; BUCKETS / 64],
}

impl Changes {
    fn inode(&mut self, number: u64) {
        let index = bucket(number);
        self.inodes[index / 64] |= 1 << (index % 64);
    }

    pub(super) fn inode_record(&mut self, inode: u64, value: Option<&[u8]>) {
        self.inode(inode);
        let mode = value
            .and_then(|v| v.get(..4))
            .map(|bytes| u32::from_le_bytes(bytes.try_into().expect("exact mode length")));
        // Directory and symlink inodes can change search authorization or
        // resolution of other names. A reclaimed record has no new mode.
        self.pathname |= mode.is_none_or(|mode| (mode & S_IFMT) != S_IFREG);
    }

    pub(super) fn block_run(&mut self, inode: u64, record: Option<&[u8]>) {
        self.inode(inode);
        if let Some(value) = record {
            self.inode_record(inode, Some(value));
        }
    }

    pub(super) fn observe(&mut self, edits: &[Edit<'_>]) {
        for edit in edits {
            if let Some(end) = edit.end {
                // Existing range edits are confined to one inode. Guard
                // that assumption so a new range cannot leave a stale hit.
                let inode = edit
                    .key
                    .get(1..9)
                    .and_then(|bytes| bytes.try_into().ok())
                    .map(u64::from_be_bytes);
                match (edit.key.first(), inode) {
                    (Some(kind @ 3), Some(inode)) if end == prefix_end(*kind, inode) => {
                        self.inode(inode)
                    }
                    // Attributes can affect resolution, including symlink targets.
                    _ => self.pathname = true,
                }
                continue;
            }
            match decode_key(edit.key) {
                Ok(Key::Inode(inode)) => self.inode_record(inode, edit.value),
                Ok(Key::Block { inode, .. } | Key::Orphan(inode)) => self.inode(inode),
                // Dirent changes, attributes and unrecognized cases revoke
                // all pathname authorizations on this mount conservatively.
                _ => self.pathname = true,
            }
        }
    }
}

impl Generations {
    pub(super) fn write_buckets(&self, inode: u64, out: &mut [u8]) -> Option<usize> {
        if out.len() != self.inodes.len() * 8 {
            return None;
        }
        for (destination, value) in out.chunks_exact_mut(8).zip(self.inodes) {
            destination.copy_from_slice(&value.to_le_bytes());
        }
        Some(bucket(inode))
    }
}
