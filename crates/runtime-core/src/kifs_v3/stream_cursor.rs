//! Resume a contiguous block lookup at the previous authenticated path.
use super::{
    BLOCK_UNITS, Bounds, EncodedKey, IoBuffer, Key, PAGE_BYTES, Page, PageRef, PositionedStorage,
    Superblock, Tree, decode_key,
};
use wasm_posix_shared::Errno;

#[derive(Clone, Copy, Eq, PartialEq)]
struct StreamPosition {
    revision: u64,
    root: PageRef,
    inode: u64,
    block: u64,
}

struct Frame {
    reference: PageRef,
    level: u8,
    slot: usize,
    bytes: [u8; PAGE_BYTES],
}

#[derive(Default)]
pub(super) struct StreamCursor {
    next: Option<StreamPosition>,
    active: bool,
    frames: IoBuffer<Frame>,
}

impl StreamCursor {
    pub(super) fn collect<S: PositionedStorage>(
        &mut self,
        tree: &mut Tree<'_, S>,
        root: Superblock,
        revision: u64,
        inode: u64,
        first: u64,
        locations: &mut [Option<PageRef>],
    ) -> Result<(), Errno> {
        let last = first
            .checked_add(locations.len() as u64)
            .ok_or(Errno::EIO)?;
        let after = EncodedKey::new(Key::Block {
            inode,
            block: first.saturating_sub(1),
        })?;
        let end = EncodedKey::new(Key::Block { inode, block: last })?;
        let lower = if first == 0 {
            &after.bytes()[..9]
        } else {
            after.bytes()
        };
        let bounds = Bounds {
            after: Some(lower),
            end: Some(end.bytes()),
        };
        let position = StreamPosition {
            revision,
            root: root.root,
            inode,
            block: first,
        };
        let mut visit = |leaf, key: &[u8], value: &[u8]| {
            let Key::Block {
                inode: owner,
                block,
            } = decode_key(key)?
            else {
                return Err(Errno::EIO);
            };
            let index = block
                .checked_sub(first)
                .filter(|i| *i < locations.len() as u64)
                .ok_or(Errno::EIO)? as usize;
            let location = PageRef::decode(value, leaf)?;
            if inode != owner
                || location
                    .number
                    .checked_add(BLOCK_UNITS)
                    .is_none_or(|end| end > leaf)
                || locations[index].replace(location).is_some()
            {
                return Err(Errno::EIO);
            }
            Ok(())
        };

        let previous = self.next.take();
        let clean = tree.edits.is_empty() && tree.base_edits.is_none_or(|map| map.is_empty());
        let contiguous = clean && previous == Some(position);
        if contiguous {
            let result = if self.active {
                Ok(())
            } else {
                self.frames.try_reserve_exact(usize::from(root.level) + 1)
            };
            match result {
                Ok(()) => {
                    let walked = (|| {
                        if !self.active {
                            self.push(tree, root.root, root.level, None, lower)?;
                            self.active = true;
                        }
                        self.walk(tree, lower, end.bytes(), &mut visit)
                    })();
                    if walked.is_ok() {
                        self.next = Some(StreamPosition {
                            block: last,
                            ..position
                        });
                    } else {
                        self.clear();
                    }
                    return walked;
                }
                // Cursor admission is optional. The ordinary scan keeps
                // its original demand-loaded workspace.
                Err(Errno::ENOMEM) => {}
                Err(error) => return Err(error),
            }
        }
        self.clear();
        tree.visit(
            root.root,
            root.level,
            None,
            bounds,
            &mut |_, leaf, key, value| {
                visit(leaf, key, value)?;
                Ok(true)
            },
        )?;
        if clean {
            self.next = Some(StreamPosition {
                block: last,
                ..position
            });
        }
        Ok(())
    }

    fn clear(&mut self) {
        self.active = false;
        self.frames = IoBuffer::new();
    }

    fn push<S: PositionedStorage>(
        &mut self,
        tree: &mut Tree<'_, S>,
        reference: PageRef,
        level: u8,
        separator: Option<&[u8]>,
        after: &[u8],
    ) -> Result<(), Errno> {
        let mut frame = Frame {
            reference,
            level,
            slot: 0,
            bytes: [0; PAGE_BYTES],
        };
        let page = tree.read(reference, level, &mut frame.bytes, false)?;
        page.verify_records(reference, level)?;
        if let Some(separator) = separator {
            if page.record(0)?.0 != separator {
                return Err(Errno::EIO);
            }
        }
        let slot = page.lower_bound(after)?;
        let exact = slot < page.count && page.record(slot)?.0 == after;
        frame.slot = if level == 0 && exact {
            slot + 1
        } else if level != 0 && slot > 0 && !exact {
            slot - 1
        } else {
            slot
        };
        self.frames.push(frame);
        Ok(())
    }

    fn walk<S: PositionedStorage>(
        &mut self,
        tree: &mut Tree<'_, S>,
        after: &[u8],
        end: &[u8],
        visit: &mut impl FnMut(u64, &[u8], &[u8]) -> Result<(), Errno>,
    ) -> Result<(), Errno> {
        while let Some(frame) = self.frames.last_mut() {
            let page = Page::open(&frame.bytes, frame.level)?;
            if frame.slot == page.count {
                self.frames.pop();
                continue;
            }
            let (key, value) = page.record(frame.slot)?;
            if key >= end {
                break;
            }
            frame.slot += 1;
            if frame.level == 0 {
                visit(frame.reference.number, key, value)?;
            } else {
                let child = PageRef::decode(value, frame.reference.number)?;
                let separator = EncodedKey::from_bytes(key);
                let level = frame.level - 1;
                self.push(tree, child, level, Some(separator.bytes()), after)?;
            }
        }
        Ok(())
    }
}
