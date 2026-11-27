//! Controlled workloads shared by the Node and OPFS index benchmark adapter.
use crate::kifs_v3::{DEFAULT_VOLUME_BLOCKS, Key, KifsVolume, KifsVolumeBuilder};
use crate::persistent_overlay::{Mutation, OverlayJournal, OverlayKey, OverlayStorage};
use alloc::{format, vec::Vec};
use wasm_posix_shared::Errno;

const BASE: [u8; 32] = [0x4b; 32];
const LOOKUPS: u32 = 4096;
const DIRECTORY_WIDTH: u32 = 256;

fn inode(file: u32) -> u64 {
    u64::from(file) + 2
}

fn parent(file: u32) -> u64 {
    100_000_000 + u64::from(file / DIRECTORY_WIDTH)
}

fn filename(file: u32) -> alloc::string::String {
    format!("file-{file:08}.txt")
}

fn inode_value(inode: u64) -> [u8; 56] {
    let mut value = [0; 56];
    value[..8].copy_from_slice(&inode.to_le_bytes());
    value
}

fn read_queries(
    files: u32,
    seed: u32,
    mut query: impl FnMut(u32, bool) -> Result<(), Errno>,
) -> Result<(), Errno> {
    let mut state = seed;
    for n in 0..LOOKUPS {
        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        query(state % files, n % 2 == 0)?;
    }
    Ok(())
}

fn list_queries(
    files: u32,
    mut list: impl FnMut(u64, &mut dyn FnMut(&[u8], &[u8]) -> Result<(), Errno>) -> Result<(), Errno>,
) -> Result<(), Errno> {
    let dirs = files.div_ceil(DIRECTORY_WIDTH);
    for directory in 0..dirs.min(16) {
        let directory = directory * dirs / dirs.min(16);
        let first = directory * DIRECTORY_WIDTH;
        let end = (first + DIRECTORY_WIDTH).min(files);
        let mut file = first;
        list(parent(file), &mut |name, value| {
            if file >= end
                || name != filename(file).as_bytes()
                || value != inode(file).to_le_bytes()
            {
                return Err(Errno::EIO);
            }
            file += 1;
            Ok(())
        })?;
        if file != end {
            return Err(Errno::EIO);
        }
    }
    Ok(())
}

pub fn run<S: OverlayStorage + Send + 'static>(
    mut storage: impl FnMut(u32) -> S,
    mut mark: impl FnMut(u32),
    format: u32,
    files: u32,
    seed: u32,
) -> Result<(), Errno> {
    if files == 0 || files > 131_072 {
        return Err(Errno::EINVAL);
    }
    mark(0);
    match format {
        0 => {
            let mut source = OverlayJournal::open(storage(0), BASE)?;
            // Ingest is reported separately. Both builds derive the same
            // sorted checkpoint from the same logical sequence of records.
            let mut batch = Vec::new();
            batch.try_reserve_exact(128).map_err(|_| Errno::ENOMEM)?;
            for dirents in [false, true] {
                for file in 0..files {
                    let (key, value) = if dirents {
                        (
                            OverlayKey::Dirent {
                                parent: parent(file),
                                name: filename(file).into_bytes(),
                            },
                            inode(file).to_le_bytes().to_vec(),
                        )
                    } else {
                        (
                            OverlayKey::Inode(inode(file)),
                            inode_value(inode(file)).to_vec(),
                        )
                    };
                    batch.push(Mutation::Put { key, value });
                    if batch.len() == 128 {
                        source.commit(&batch)?;
                        batch.clear();
                    }
                }
                if !batch.is_empty() {
                    source.commit(&batch)?;
                    batch.clear();
                }
            }
            mark(1);
            let mut compacted = source.compact_metadata_reachable_into(storage(1), |_, _| true)?;
            let end = compacted.compaction_revision().0;
            let checkpoint = compacted.checkpoint_blocks_with_metadata_into(storage(2))?;
            drop(source);
            mark(2);
            let mut opened = OverlayJournal::open_with_checkpoint_metadata(
                compacted.into_storage(),
                checkpoint.into_storage(),
                BASE,
                end,
            )?;
            mark(3);
            read_queries(files, seed, |file, by_name| {
                let key = if by_name {
                    OverlayKey::Dirent {
                        parent: parent(file),
                        name: filename(file).into_bytes(),
                    }
                } else {
                    OverlayKey::Inode(inode(file))
                };
                let value = opened.metadata_value(&key)?.flatten().ok_or(Errno::EIO)?;
                verify_value(file, by_name, &value)
            })?;
            mark(4);
            list_queries(files, |parent, visit| {
                opened.for_each_dirent(parent, Some(parent + 1), |key, value| {
                    let OverlayKey::Dirent { name, .. } = key else {
                        return Err(Errno::EIO);
                    };
                    visit(name, value.ok_or(Errno::EIO)?)
                })
            })?;
            mark(5);
            let mut count = 0;
            opened.for_each_metadata(|_, value| {
                value.ok_or(Errno::EIO)?;
                count += 1;
                Ok(())
            })?;
            if count != 2 * files {
                return Err(Errno::EIO);
            }
        }
        1 => {
            mark(1);
            let mut writer = KifsVolumeBuilder::new(storage(1), DEFAULT_VOLUME_BLOCKS, BASE)?;
            for file in 0..files {
                writer.push_metadata(Key::Inode(inode(file)), &inode_value(inode(file)))?;
            }
            for file in 0..files {
                writer.push_metadata(
                    Key::Dirent {
                        parent: parent(file),
                        name: filename(file).as_bytes(),
                    },
                    &inode(file).to_le_bytes(),
                )?;
            }
            let sealed = writer.finish(100_000_001 + u64::from(files.div_ceil(DIRECTORY_WIDTH)))?;
            mark(2);
            let mut opened = KifsVolume::open(sealed.into_storage(), BASE)?;
            mark(3);
            let mut value = [0; 56];
            read_queries(files, seed, |file, by_name| {
                let length = if by_name {
                    let name = filename(file);
                    opened.lookup(
                        Key::Dirent {
                            parent: parent(file),
                            name: name.as_bytes(),
                        },
                        &mut value,
                    )?
                } else {
                    opened.lookup(Key::Inode(inode(file)), &mut value)?
                }
                .ok_or(Errno::EIO)?;
                verify_value(file, by_name, &value[..length])
            })?;
            mark(4);
            list_queries(files, |parent, visit| {
                opened.for_directory(parent, None, visit)
            })?;
            mark(5);
            opened.verify()?;
        }
        _ => return Err(Errno::EINVAL),
    }
    mark(6);
    Ok(())
}

fn verify_value(file: u32, by_name: bool, value: &[u8]) -> Result<(), Errno> {
    let valid = if by_name {
        value == inode(file).to_le_bytes()
    } else {
        value == inode_value(inode(file))
    };
    if valid { Ok(()) } else { Err(Errno::EIO) }
}

/// Independent sequential control. This exercises the same transport and
/// flush primitive used by both formats with identical positioned I/O.
pub fn run_payload(
    mut storage: impl OverlayStorage,
    mut mark: impl FnMut(u32),
) -> Result<(), Errno> {
    const CHUNK: usize = 64 * 1024;
    const CHUNKS: u64 = 256;
    let mut bytes = crate::IoBuffer::try_filled(CHUNK, 53)?;
    mark(0);
    for block in 0..CHUNKS {
        bytes[0] = block as u8;
        storage.write_all_at(block * CHUNK as u64, &bytes)?;
    }
    storage.flush()?;
    mark(1);
    for block in 0..CHUNKS {
        storage.read_exact_at(block * CHUNK as u64, &mut bytes)?;
        if bytes[0] != block as u8 || bytes[CHUNK - 1] != 53 {
            return Err(Errno::EIO);
        }
    }
    mark(2);
    Ok(())
}
