use std::env;
use std::fs::{self, File, OpenOptions};
#[cfg(not(unix))]
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
#[cfg(unix)]
use std::os::unix::fs::{FileExt, MetadataExt};
#[cfg(target_os = "macos")]
use std::os::fd::AsRawFd;

use runtime_core::kandelo_image_write::{
    Content, ContentSource, KandeloImageConfig, KandeloImageWriter,
};
use runtime_core::vfsi_container::{self, ContainerSections};
use wasm_posix_shared::Errno;

const MIB: u64 = 1024 * 1024;
const FILE_SIZE: u64 = (1u64 << 32) - 16 * MIB;
const IMAGE_SIZE: u64 = (1u64 << 32) + 64 * MIB;
const TAIL_BYTES: u64 = 2 * MIB;

struct FixtureStage(PathBuf);

impl Drop for FixtureStage {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn write_at(file: &mut File, offset: u64, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    { file.write_all_at(bytes, offset) }
    #[cfg(not(unix))]
    {
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(bytes)
    }
}

fn punch_zero_range(file: &File, start: u64, length: u64) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        #[repr(C)]
        struct PunchHole { flags: u32, reserved: u32, offset: i64, length: i64 }
        unsafe extern "C" { fn fcntl(fd: i32, command: i32, ...) -> i32; }
        const F_PUNCHHOLE: i32 = 99;
        let range = PunchHole { flags: 0, reserved: 0,
            offset: i64::try_from(start).map_err(|_| std::io::ErrorKind::InvalidInput)?,
            length: i64::try_from(length).map_err(|_| std::io::ErrorKind::InvalidInput)?,
        };
        if unsafe { fcntl(file.as_raw_fd(), F_PUNCHHOLE, &range as *const PunchHole) } == -1 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (file, start, length);
        Err(std::io::ErrorKind::Unsupported.into())
    }
}

fn check_physical_size(file: &File, position: u64, written: u64, zeros: &[(u64, u64)]) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(unix)]
    if file.metadata()?.blocks().saturating_mul(512) > 512 * MIB {
        file.sync_all()?;
        for &(start, length) in zeros { punch_zero_range(file, start, length)?; }
        file.sync_all()?;
        let physical = file.metadata()?.blocks().saturating_mul(512);
        if physical > 512 * MIB {
            return Err(format!("fixture exceeded its physical storage budget: {physical} allocated bytes, {written} written bytes, image position {position}").into());
        }
        eprintln!("reclaimed known-zero fixture ranges at {position}: {physical} physical bytes");
    }
    Ok(())
}

struct LargeFile {
    size: u64,
    patterned_tail: bool,
}

impl ContentSource for LargeFile {
    fn read_exact_at(&self, id: u64, offset: u64, destination: &mut [u8]) -> Result<(), Errno> {
        if id != 1 {
            return Err(Errno::EIO);
        }
        destination.fill(0);
        if !self.patterned_tail { return Ok(()); }
        let tail_start = self.size - TAIL_BYTES - 13;
        if offset + destination.len() as u64 <= tail_start {
            return Ok(());
        }
        for (index, byte) in destination.iter_mut().enumerate() {
            let position = offset + index as u64;
            if (tail_start..tail_start + TAIL_BYTES).contains(&position) {
                let tail_position = position - tail_start;
                *byte = ((tail_position / 4096) ^ tail_position) as u8;
            }
        }
        Ok(())
    }
}

fn image_result<T>(result: Result<T, Errno>) -> Result<T, Box<dyn std::error::Error>> {
    result.map_err(|error| format!("{error:?}").into())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1);
    let output = args.next().ok_or("expected output image path")?;
    let guest_program = args.next().ok_or("expected guest program path")?;
    let boot_counter = args.next().map(fs::read).transpose()?;
    if args.next().is_some() {
        return Err("unexpected argument".into());
    }
    let program = fs::read(guest_program)?;
    let dense_size = env::var("KANDELO_DENSE_FILE_BYTES").ok().map(|value| value.parse::<u64>()).transpose()?;
    let file_size = dense_size.unwrap_or(FILE_SIZE);
    let first_block_hole = match env::var("KANDELO_FIRST_BLOCK_HOLE") {
        Ok(value) if value == "1" => true,
        Err(env::VarError::NotPresent) => false,
        _ => return Err("KANDELO_FIRST_BLOCK_HOLE must be 1 when present".into()),
    };
    if first_block_hole && dense_size.is_none() {
        return Err("first-block-hole fixtures require KANDELO_DENSE_FILE_BYTES".into());
    }
    if file_size < TAIL_BYTES + 13 { return Err("fixture file is too short".into()); }
    let image_size = match dense_size {
        Some(size) => size.checked_add(80 * MIB).ok_or("fixture image size overflow")?,
        None => IMAGE_SIZE,
    };
    let config = KandeloImageConfig {
        size_bytes: image_size,
        max_size_bytes: Some(image_size),
        growable_to_bytes: image_size,
        now_ms: wasm_posix_shared::KANDELO_REFERENCE_EPOCH_MILLIS,
    };
    let mut writer = image_result(match dense_size {
        Some(_) => KandeloImageWriter::mkfs_with_inode_capacity(config, Some(128)),
        None => KandeloImageWriter::mkfs(config),
    })?;
    image_result(writer.declare_deferred_section())?;
    let bin = image_result(writer.mkdir(writer.root(), b"bin", 0o755))?;
    image_result(writer.create_file(
        bin,
        b"persistence-overwrite",
        0o755,
        Content::Bytes(&program),
    ))?;
    image_result(writer.create_file(writer.root(), b"state", 0o644, Content::Bytes(
        if boot_counter.is_some() { b"0" } else { b"before\n" },
    )))?;
    if let Some(counter) = boot_counter {
        image_result(writer.create_file(bin, b"persistence-boot-counter", 0o755, Content::Bytes(&counter)))?;
        let etc = image_result(writer.mkdir(writer.root(), b"etc", 0o755))?;
        let kandelo = image_result(writer.mkdir(etc, b"kandelo", 0o755))?;
        image_result(writer.create_file(kandelo, b"demo.json", 0o644, Content::Bytes(br##"{
            "version": 1,
            "defaultProfile": "probe",
            "profiles": {"probe": {"identity": {
                "title": "Large persistence probe",
                "summary": "Positioned persistent page boot",
                "accent": "#123456",
                "glyph": "sh"
            }}}
        }"##)))?;
        image_result(writer.create_file(kandelo, b"experimental-terminal-session.json", 0o644, Content::Bytes(br#"{
            "kind": "kandelo-experimental-terminal-session",
            "version": 1,
            "initial": {
                "path": "/bin/persistence-boot-counter",
                "argv": ["persistence-boot-counter"],
                "uid": 0,
                "gid": 0
            }
        }"#)))?;
    }
    if first_block_hole {
        let count = u32::try_from(file_size.div_ceil(4096))?;
        image_result(writer.create_sparse_file_from(writer.root(), b"large", 0o644,
            1, file_size, |visit| {
                for block in 1..count { visit(block)?; }
                Ok(())
            }))?;
    } else {
        image_result(writer.create_file(writer.root(), b"large", 0o644,
            Content::Deferred { id: 1, len: file_size }))?;
    }
    let body = image_result(writer.finish())?;
    if body.len() <= u32::MAX as u64 || body.resident_bytes() >= 128 * MIB {
        return Err("fixture is not a bounded-memory v2 image".into());
    }
    let sections = ContainerSections {
        lazy_json: b"",
        archive_json: None,
        metadata_json: None,
        kernel_lazy: None,
    };
    let header = image_result(vfsi_container::header_for_body(
        body.len(),
        sections.flags(),
    ))?;
    let trailer = image_result(vfsi_container::trailer(&sections))?;
    let output = PathBuf::from(output);
    let stage = output.with_extension(format!("stage-{}", std::process::id()));
    let mut file = OpenOptions::new().write(true).create_new(true).open(&stage)?;
    let _cleanup = FixtureStage(stage.clone());
    file.set_len(header.len() as u64 + body.len() + trailer.len() as u64)?;
    let mut zeros = Vec::new();
    let mut zero_start: Option<u64> = None;
    let close_zero_range = |end: u64, zero_start: &mut Option<u64>, zeros: &mut Vec<(u64, u64)>| {
        if let Some(start) = zero_start.take() {
            let start = start.div_ceil(4096) * 4096;
            let end = end / 4096 * 4096;
            if start < end { zeros.push((start, end - start)); }
        }
    };
    check_physical_size(&file, 0, 0, &zeros)?;
    write_at(&mut file, 0, &header)?;
    let mut written = header.len() as u64;
    let mut buffer = vec![0; MIB as usize];
    let content = LargeFile { size: file_size, patterned_tail: dense_size.is_none() };
    let mut offset = 0;
    while offset < body.len() {
        let count = image_result(body.read_at(&content, offset, &mut buffer))?;
        if count == 0 {
            return Err("fixture body ended early".into());
        }
        for (index, block) in buffer[..count].chunks(4096).enumerate() {
            let position = header.len() as u64 + offset + index as u64 * 4096;
            if block.iter().any(|byte| *byte != 0) {
                close_zero_range(position, &mut zero_start, &mut zeros);
                write_at(&mut file, position, block)?;
                written += block.len() as u64;
            } else {
                zero_start.get_or_insert(position);
            }
        }
        check_physical_size(&file, offset, written, &zeros)?;
        offset += count as u64;
    }
    close_zero_range(header.len() as u64 + body.len(), &mut zero_start, &mut zeros);
    write_at(&mut file, header.len() as u64 + body.len(), &trailer)?;
    file.set_len(header.len() as u64 + body.len() + trailer.len() as u64)?;
    file.sync_all()?;
    check_physical_size(&file, body.len(), written + trailer.len() as u64, &zeros)?;
    drop(file);
    fs::rename(&stage, &output)?;
    Ok(())
}
