use alloc::vec::Vec;
use miniz_oxide::inflate::stream::{InflateState, inflate};
use miniz_oxide::{DataFormat, MZError, MZFlush, MZStatus};
use sha2::{Digest, Sha256};
use wasm_posix_shared::Errno;

use crate::kandelo_image_fs::BlockSource;
use crate::zip::ZipEntry;

const IO_BYTES: usize = 64 * 1024;
const CHECKPOINT_BYTES: u64 = 1024 * 1024;
const CHECKPOINTS: usize = 8;
pub(crate) const DIRECTORY_CACHE_BYTES: usize = 4 * 1024 * 1024;

fn buffer(length: usize) -> Result<Vec<u8>, Errno> {
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(length).map_err(|_| Errno::ENOMEM)?;
    bytes.resize(length, 0);
    Ok(bytes)
}

fn read16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap())
}

fn read32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn read_at<S: BlockSource>(
    source: &S,
    size: u64,
    offset: u64,
    target: &mut [u8],
) -> Result<(), Errno> {
    if offset
        .checked_add(target.len() as u64)
        .is_none_or(|end| end > size)
    {
        return Err(Errno::EINVAL);
    }
    source.read_exact_at(offset, target)
}

struct EntryOffset {
    name_hash: [u8; 32],
    offset: u64,
}

pub(crate) struct Directory {
    entries: Vec<EntryOffset>,
    size: u64,
    end: u64,
}

impl Directory {
    pub(crate) fn read<S: BlockSource>(source: &S, size: u64) -> Result<Self, Errno> {
        let tail_start = size.saturating_sub(65557);
        let mut tail = buffer((size - tail_start) as usize)?;
        read_at(source, size, tail_start, &mut tail)?;
        let end = crate::zip::find_eocd(&tail)?;
        if read16(&tail, end + 4) != 0
            || read16(&tail, end + 6) != 0
            || read16(&tail, end + 8) != read16(&tail, end + 10)
            || end + 22 + read16(&tail, end + 20) as usize != tail.len()
        {
            return Err(Errno::EINVAL);
        }
        let count = read16(&tail, end + 10);
        let mut offset = read32(&tail, end + 16) as u64;
        let directory_end = offset
            .checked_add(read32(&tail, end + 12) as u64)
            .ok_or(Errno::EINVAL)?;
        if directory_end > tail_start + end as u64 {
            return Err(Errno::EINVAL);
        }
        drop(tail);
        let mut name_bytes = buffer(u16::MAX as usize)?;
        let mut entries = Vec::new();
        entries
            .try_reserve_exact(count as usize)
            .map_err(|_| Errno::ENOMEM)?;
        for _ in 0..count {
            let mut header = [0; 46];
            if offset
                .checked_add(header.len() as u64)
                .is_none_or(|end| end > directory_end)
            {
                return Err(Errno::EINVAL);
            }
            read_at(source, size, offset, &mut header)?;
            if read32(&header, 0) != 0x0201_4b50 {
                return Err(Errno::EINVAL);
            }
            let method = read16(&header, 10);
            let compressed_size = read32(&header, 20);
            let uncompressed_size = read32(&header, 24);
            let local_offset = read32(&header, 42);
            if read16(&header, 8) & 0x0009 != 0
                || !matches!(method, 0 | 8)
                || compressed_size == u32::MAX
                || uncompressed_size == u32::MAX
                || local_offset == u32::MAX
                || read16(&header, 34) != 0
            {
                return Err(Errno::EINVAL);
            }
            let name_length = read16(&header, 28) as usize;
            let next = offset
                + 46
                + name_length as u64
                + read16(&header, 30) as u64
                + read16(&header, 32) as u64;
            if next > directory_end {
                return Err(Errno::EINVAL);
            }
            let member_name = &mut name_bytes[..name_length];
            read_at(source, size, offset + 46, member_name)?;
            core::str::from_utf8(member_name).map_err(|_| Errno::EINVAL)?;
            entries.push(EntryOffset {
                name_hash: Sha256::digest(member_name).into(),
                offset,
            });
            offset = next;
        }
        entries.sort_unstable_by_key(|entry| (entry.name_hash, entry.offset));
        Ok(Self {
            entries,
            size,
            end: directory_end,
        })
    }

    pub(crate) fn retained_bytes(&self) -> usize {
        self.entries.capacity() * core::mem::size_of::<EntryOffset>()
    }

    pub(crate) fn find_member<S: BlockSource>(
        &self,
        source: &S,
        name: &[u8],
    ) -> Result<ZipEntry, Errno> {
        let name_hash: [u8; 32] = Sha256::digest(name).into();
        let start = self
            .entries
            .partition_point(|entry| entry.name_hash < name_hash);
        for entry in self.entries[start..]
            .iter()
            .take_while(|entry| entry.name_hash == name_hash)
        {
            let mut header = [0; 46];
            read_at(source, self.size, entry.offset, &mut header)?;
            if read32(&header, 0) != 0x0201_4b50
                || read16(&header, 8) & 0x0009 != 0
                || !matches!(read16(&header, 10), 0 | 8)
                || read16(&header, 34) != 0
                || [20, 24, 42]
                    .into_iter()
                    .any(|field| read32(&header, field) == u32::MAX)
            {
                return Err(Errno::EINVAL);
            }
            let name_length = read16(&header, 28) as usize;
            if entry.offset + 46 + name_length as u64 > self.end {
                return Err(Errno::EINVAL);
            }
            let mut owned_name = buffer(name_length)?;
            read_at(source, self.size, entry.offset + 46, &mut owned_name)?;
            if owned_name != name {
                continue;
            }
            return Ok(ZipEntry {
                name: owned_name,
                creator_os: (read16(&header, 4) >> 8) as u8,
                method: read16(&header, 10),
                compressed_size: read32(&header, 20),
                uncompressed_size: read32(&header, 24),
                external_attrs: read32(&header, 38),
                local_offset: read32(&header, 42),
            });
        }
        Err(Errno::ENOENT)
    }
}

#[cfg(test)]
fn find_member<S: BlockSource>(source: &S, size: u64, name: &[u8]) -> Result<ZipEntry, Errno> {
    Directory::read(source, size)?.find_member(source, name)
}

struct Checkpoint {
    position: u64,
    compressed: u64,
    state: InflateState,
}

pub(crate) struct MemberReader {
    pub(crate) entry: ZipEntry,
    data_start: u64,
    states: Vec<InflateState>,
    checkpoints: Vec<Checkpoint>,
    input: Vec<u8>,
    input_start: u64,
    input_position: usize,
    input_length: usize,
    output: Vec<u8>,
    output_length: usize,
    position: u64,
    finished: bool,
}

impl MemberReader {
    pub(crate) fn new<S: BlockSource>(
        source: &S,
        size: u64,
        entry: ZipEntry,
    ) -> Result<Self, Errno> {
        let mut header = [0; 30];
        let local = entry.local_offset as u64;
        read_at(source, size, local, &mut header)?;
        if read32(&header, 0) != 0x0403_4b50
            || read16(&header, 8) != entry.method
            || read16(&header, 6) & 0x0009 != 0
            || read16(&header, 26) as usize != entry.name.len()
            || !matches!(entry.method, 0 | 8)
        {
            return Err(Errno::EINVAL);
        }
        let mut local_name = buffer(entry.name.len())?;
        read_at(source, size, local + 30, &mut local_name)?;
        if local_name != entry.name {
            return Err(Errno::EINVAL);
        }
        let data_start = local + 30 + local_name.len() as u64 + read16(&header, 28) as u64;
        if data_start
            .checked_add(entry.compressed_size as u64)
            .is_none_or(|end| end > size)
            || entry.method == 0 && entry.compressed_size != entry.uncompressed_size
        {
            return Err(Errno::EINVAL);
        }
        let mut states = Vec::new();
        let mut checkpoints = Vec::new();
        let (input, output) = if entry.method == 8 {
            states.try_reserve_exact(1).map_err(|_| Errno::ENOMEM)?;
            states.push(InflateState::new(DataFormat::Raw));
            checkpoints
                .try_reserve_exact(CHECKPOINTS)
                .map_err(|_| Errno::ENOMEM)?;
            (buffer(IO_BYTES)?, buffer(IO_BYTES)?)
        } else {
            (Vec::new(), Vec::new())
        };
        Ok(Self {
            entry,
            data_start,
            states,
            checkpoints,
            input,
            input_start: 0,
            input_position: 0,
            input_length: 0,
            output,
            output_length: 0,
            position: 0,
            finished: false,
        })
    }

    fn seek_back(&mut self, offset: u64) {
        let checkpoint = self
            .checkpoints
            .iter()
            .rev()
            .find(|checkpoint| checkpoint.position <= offset);
        if let Some(checkpoint) = checkpoint {
            self.states[0].clone_from(&checkpoint.state);
            self.position = checkpoint.position;
            self.input_start = checkpoint.compressed;
        } else {
            self.states[0].reset(DataFormat::Raw);
            self.position = 0;
            self.input_start = 0;
        }
        self.input_position = 0;
        self.input_length = 0;
        self.output_length = 0;
        self.finished = false;
    }

    fn next_window<S: BlockSource>(&mut self, source: &S) -> Result<(), Errno> {
        self.output_length = 0;
        while !self.finished && self.output_length == 0 {
            if self.input_position == self.input_length {
                self.input_start += self.input_length as u64;
                self.input_position = 0;
                self.input_length = (self.entry.compressed_size as u64 - self.input_start)
                    .min(self.input.len() as u64) as usize;
                source.read_exact_at(
                    self.data_start + self.input_start,
                    &mut self.input[..self.input_length],
                )?;
            }
            let result = inflate(
                &mut self.states[0],
                &self.input[self.input_position..self.input_length],
                &mut self.output,
                MZFlush::None,
            );
            self.input_position += result.bytes_consumed;
            self.output_length = result.bytes_written;
            self.position += self.output_length as u64;
            if self.position > self.entry.uncompressed_size as u64 {
                return Err(Errno::EIO);
            }
            match result.status {
                Ok(MZStatus::StreamEnd) => {
                    if self.position != self.entry.uncompressed_size as u64
                        || self.input_start + self.input_position as u64
                            != self.entry.compressed_size as u64
                    {
                        return Err(Errno::EIO);
                    }
                    self.finished = true;
                }
                Ok(_) | Err(MZError::Buf)
                    if result.bytes_consumed != 0 || result.bytes_written != 0 => {}
                _ => return Err(Errno::EIO),
            }
        }
        let checkpoint_position = self
            .checkpoints
            .last()
            .map_or(0, |checkpoint| checkpoint.position);
        if !self.finished && self.position >= checkpoint_position + CHECKPOINT_BYTES {
            if self.checkpoints.len() == CHECKPOINTS {
                self.checkpoints.remove(0);
            }
            self.checkpoints.push(Checkpoint {
                position: self.position,
                compressed: self.input_start + self.input_position as u64,
                state: self.states[0].clone(),
            });
        }
        Ok(())
    }

    pub(crate) fn read_at<S: BlockSource>(
        &mut self,
        source: &S,
        offset: u64,
        target: &mut [u8],
    ) -> Result<usize, Errno> {
        let length = target
            .len()
            .min((self.entry.uncompressed_size as u64).saturating_sub(offset) as usize);
        if length == 0 {
            return Ok(0);
        }
        if self.entry.method == 0 {
            source.read_exact_at(self.data_start + offset, &mut target[..length])?;
            return Ok(length);
        }
        if offset < self.position - self.output_length as u64 {
            self.seek_back(offset);
        }
        let mut done = 0;
        while done < length {
            let at = offset + done as u64;
            if at >= self.position {
                if self.finished {
                    return Err(Errno::EIO);
                }
                self.next_window(source)?;
                continue;
            }
            let start = (at - (self.position - self.output_length as u64)) as usize;
            let count = (length - done).min(self.output_length - start);
            target[done..done + count].copy_from_slice(&self.output[start..start + count]);
            done += count;
        }
        if offset + done as u64 == self.entry.uncompressed_size as u64 {
            while !self.finished {
                self.next_window(source)?;
            }
        }
        Ok(done)
    }
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    pub(crate) struct Archive {
        pub(crate) prefix: Vec<u8>,
        pub(crate) body: Option<Vec<u8>>,
        pub(crate) tail: Vec<u8>,
        pub(crate) compressed: u32,
    }

    impl Archive {
        pub(crate) fn new(name: &[u8], size: u32, compressed: Option<Vec<u8>>) -> Self {
            let method = if compressed.is_some() { 8u16 } else { 0 };
            let compressed_size = compressed.as_ref().map_or(size, |bytes| bytes.len() as u32);
            let mut prefix = alloc::vec![0; 30];
            prefix[0..4].copy_from_slice(&0x0403_4b50u32.to_le_bytes());
            prefix[8..10].copy_from_slice(&method.to_le_bytes());
            prefix[18..22].copy_from_slice(&compressed_size.to_le_bytes());
            prefix[22..26].copy_from_slice(&size.to_le_bytes());
            prefix[26..28].copy_from_slice(&(name.len() as u16).to_le_bytes());
            prefix.extend_from_slice(name);
            let mut tail = alloc::vec![0; 46];
            tail[0..4].copy_from_slice(&0x0201_4b50u32.to_le_bytes());
            tail[10..12].copy_from_slice(&method.to_le_bytes());
            tail[20..24].copy_from_slice(&compressed_size.to_le_bytes());
            tail[24..28].copy_from_slice(&size.to_le_bytes());
            tail[28..30].copy_from_slice(&(name.len() as u16).to_le_bytes());
            tail.extend_from_slice(name);
            let directory_length = tail.len() as u32;
            let mut end = [0; 22];
            end[0..4].copy_from_slice(&0x0605_4b50u32.to_le_bytes());
            end[8..10].copy_from_slice(&1u16.to_le_bytes());
            end[10..12].copy_from_slice(&1u16.to_le_bytes());
            end[12..16].copy_from_slice(&directory_length.to_le_bytes());
            end[16..20].copy_from_slice(&(prefix.len() as u32 + compressed_size).to_le_bytes());
            tail.extend_from_slice(&end);
            Self {
                prefix,
                body: compressed,
                tail,
                compressed: compressed_size,
            }
        }
    }

    impl BlockSource for Archive {
        fn len(&self) -> u64 {
            self.prefix.len() as u64 + self.compressed as u64 + self.tail.len() as u64
        }

        fn read_exact_at(&self, offset: u64, target: &mut [u8]) -> Result<(), Errno> {
            if offset
                .checked_add(target.len() as u64)
                .is_none_or(|end| end > self.len())
            {
                return Err(Errno::EIO);
            }
            let mut done = 0;
            while done < target.len() {
                let position = offset + done as u64;
                let body_start = self.prefix.len() as u64;
                let tail_start = body_start + self.compressed as u64;
                if position < body_start {
                    let count = (target.len() - done).min((body_start - position) as usize);
                    target[done..done + count].copy_from_slice(
                        &self.prefix[position as usize..position as usize + count],
                    );
                    done += count;
                } else if position < tail_start {
                    let count = (target.len() - done).min((tail_start - position) as usize);
                    match &self.body {
                        Some(body) => {
                            let start = (position - body_start) as usize;
                            target[done..done + count].copy_from_slice(&body[start..start + count]);
                        }
                        None => target[done..done + count].fill(86),
                    }
                    done += count;
                } else {
                    let start = (position - tail_start) as usize;
                    let count = target.len() - done;
                    target[done..].copy_from_slice(&self.tail[start..start + count]);
                    done += count;
                }
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::Archive;
    use super::*;
    use core::cell::Cell;

    #[test]
    fn positioned_stored_member_does_not_allocate_the_archive_or_member() {
        let source = Archive::new(b"large", 128 * 1024 * 1024, None);
        let entry = find_member(&source, source.len(), b"large").unwrap();
        let mut reader = MemberReader::new(&source, source.len(), entry).unwrap();
        for offset in [0, 65_531, 127 * 1024 * 1024, 128 * 1024 * 1024 - 10] {
            let mut bytes = [0; 32];
            let count = reader.read_at(&source, offset, &mut bytes).unwrap();
            assert_eq!(count, 32usize.min((128 * 1024 * 1024 - offset) as usize));
            assert!(bytes[..count].iter().all(|byte| *byte == 86));
        }
        assert_eq!(reader.read_at(&source, u64::MAX, &mut [0; 1]), Ok(0));
        assert!(reader.input.is_empty() && reader.output.is_empty() && reader.states.is_empty());
    }

    #[test]
    fn deflated_sequential_and_backward_reads_keep_bounded_decoder_checkpoints() {
        let data: Vec<u8> = (0..12 * 1024 * 1024)
            .map(|offset| (offset % 251) as u8)
            .collect();
        let source = Archive::new(
            b"deflated",
            data.len() as u32,
            Some(miniz_oxide::deflate::compress_to_vec(&data, 6)),
        );
        let entry = find_member(&source, source.len(), b"deflated").unwrap();
        let mut reader = MemberReader::new(&source, source.len(), entry).unwrap();
        let mut target = [0; 8191];
        for offset in (0..data.len()).step_by(target.len()) {
            let count = reader.read_at(&source, offset as u64, &mut target).unwrap();
            assert_eq!(&target[..count], &data[offset..offset + count]);
        }
        assert_eq!(reader.position, data.len() as u64);
        assert_eq!(reader.checkpoints.len(), CHECKPOINTS);
        for offset in [7 * 1024 * 1024 + 13, 5 * 1024 * 1024, 101, data.len() - 31] {
            let count = reader.read_at(&source, offset as u64, &mut target).unwrap();
            assert_eq!(&target[..count], &data[offset..offset + count]);
        }
        assert!(reader.checkpoints.len() <= CHECKPOINTS);
        assert_eq!(reader.input.capacity(), IO_BYTES);
        assert_eq!(reader.output.capacity(), IO_BYTES);
        assert_eq!(reader.states.capacity(), 1);
        assert_eq!(reader.checkpoints.capacity(), CHECKPOINTS);
        let retained = reader.input.capacity()
            + reader.output.capacity()
            + reader.entry.name.capacity()
            + reader.states.capacity() * core::mem::size_of::<InflateState>()
            + reader.checkpoints.capacity() * core::mem::size_of::<Checkpoint>();
        assert!(retained < 1024 * 1024);
    }

    #[test]
    fn member_reads_preserve_transport_errors_and_reject_wrong_local_names() {
        struct FailingSource<'a> {
            source: &'a Archive,
            fail: Cell<bool>,
        }
        impl BlockSource for FailingSource<'_> {
            fn len(&self) -> u64 {
                self.source.len()
            }
            fn read_exact_at(&self, offset: u64, target: &mut [u8]) -> Result<(), Errno> {
                if self.fail.get() {
                    return Err(Errno::ENOSPC);
                }
                self.source.read_exact_at(offset, target)
            }
        }
        let mut source = Archive::new(b"file", 100, None);
        let entry = find_member(&source, source.len(), b"file").unwrap();
        let failing = FailingSource {
            source: &source,
            fail: Cell::new(false),
        };
        let mut reader = MemberReader::new(&failing, failing.len(), entry.clone()).unwrap();
        failing.fail.set(true);
        assert_eq!(reader.read_at(&failing, 0, &mut [0; 1]), Err(Errno::ENOSPC));
        source.prefix[30] ^= 1;
        assert!(matches!(
            MemberReader::new(&source, source.len(), entry),
            Err(Errno::EINVAL)
        ));
    }

    #[test]
    fn directory_rejects_out_of_range_records_and_unsupported_flags() {
        for flag in [1u16, 8] {
            let mut source = Archive::new(b"file", 100, None);
            source.tail[8..10].copy_from_slice(&flag.to_le_bytes());
            assert_eq!(
                find_member(&source, source.len(), b"file"),
                Err(Errno::EINVAL)
            );
        }
        let mut source = Archive::new(b"file", 100, None);
        source.tail[28..30].copy_from_slice(&u16::MAX.to_le_bytes());
        assert_eq!(
            find_member(&source, source.len(), b"file"),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn directory_index_bounds_metadata_and_avoids_a_full_scan_for_each_member() {
        struct CountingSource {
            bytes: Vec<u8>,
            reads: Cell<usize>,
        }
        impl BlockSource for CountingSource {
            fn len(&self) -> u64 {
                self.bytes.len() as u64
            }
            fn read_exact_at(&self, offset: u64, target: &mut [u8]) -> Result<(), Errno> {
                self.reads.set(self.reads.get() + 1);
                let bytes = self
                    .bytes
                    .get(offset as usize..offset as usize + target.len())
                    .ok_or(Errno::EIO)?;
                target.copy_from_slice(bytes);
                Ok(())
            }
        }
        let mut body = Vec::new();
        let mut central = Vec::new();
        for index in 0..200 {
            let name = alloc::format!("file-{index:03}");
            let archive = Archive::new(name.as_bytes(), 16, None);
            let mut record = archive.tail[..archive.tail.len() - 22].to_vec();
            record[42..46].copy_from_slice(&(body.len() as u32).to_le_bytes());
            central.extend_from_slice(&record);
            body.extend_from_slice(&archive.prefix);
            body.extend_from_slice(&[86; 16]);
        }
        let mut end = [0; 22];
        end[0..4].copy_from_slice(&0x0605_4b50u32.to_le_bytes());
        end[8..10].copy_from_slice(&200u16.to_le_bytes());
        end[10..12].copy_from_slice(&200u16.to_le_bytes());
        end[12..16].copy_from_slice(&(central.len() as u32).to_le_bytes());
        end[16..20].copy_from_slice(&(body.len() as u32).to_le_bytes());
        body.extend_from_slice(&central);
        body.extend_from_slice(&end);
        let source = CountingSource {
            bytes: body,
            reads: Cell::new(0),
        };
        let directory = Directory::read(&source, source.len()).unwrap();
        source.reads.set(0);
        for index in 0..200 {
            let name = alloc::format!("file-{index:03}");
            let entry = directory.find_member(&source, name.as_bytes()).unwrap();
            let mut reader = MemberReader::new(&source, source.len(), entry).unwrap();
            let mut bytes = [0; 16];
            assert_eq!(reader.read_at(&source, 0, &mut bytes), Ok(16));
            assert_eq!(bytes, [86; 16]);
        }
        assert_eq!(source.reads.get(), 200 * 5);
        assert!(u16::MAX as usize * core::mem::size_of::<EntryOffset>() <= DIRECTORY_CACHE_BYTES);
        assert!(directory.retained_bytes() <= DIRECTORY_CACHE_BYTES);
    }

    #[test]
    fn deflate_rejects_truncated_extra_and_misdeclared_output() {
        let data = alloc::vec![86; 100_000];
        let compressed = miniz_oxide::deflate::compress_to_vec(&data, 6);
        for (size, bytes) in [
            (data.len() - 1, compressed.clone()),
            (data.len() + 1, compressed.clone()),
            (data.len(), compressed[..compressed.len() - 1].to_vec()),
            (data.len(), [compressed.as_slice(), &[0]].concat()),
        ] {
            let source = Archive::new(b"file", size as u32, Some(bytes));
            let entry = find_member(&source, source.len(), b"file").unwrap();
            let mut reader = MemberReader::new(&source, source.len(), entry).unwrap();
            assert_eq!(
                reader.read_at(&source, 0, &mut alloc::vec![0; size]),
                Err(Errno::EIO)
            );
        }
    }
}
